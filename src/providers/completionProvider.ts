import { container } from "tsyringe";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  CompletionParams,
  Connection,
  InsertTextFormat,
  MarkupKind,
  Position,
  Range,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { IElmWorkspace } from "../elmWorkspace";
import { IForest, ITreeContainer } from "../forest";
import { comparePosition, PositionUtil } from "../positionUtil";
import { getEmptyTypes } from "../util/elmUtils";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { HintHelper } from "../util/hintHelper";
import { ImportUtils, IPossibleImport } from "../util/importUtils";
import { RefactorEditUtils } from "../util/refactorEditUtils";
import { TreeUtils } from "../util/treeUtils";
import RANKING_LIST from "./ranking";
import { DiagnosticsProvider } from ".";
import { TypeChecker } from "../util/types/typeChecker";
import escapeStringRegexp from "escape-string-regexp";
import { TRecord } from "../util/types/typeInference";
import { ICompletionParams } from "./paramsExtensions";

export type CompletionResult =
  | CompletionItem[]
  | CompletionList
  | null
  | undefined;

interface ICompletionOptions {
  label: string;
  range: Range;
  sortPrefix: string;
  kind?: CompletionItemKind;
  markdownDocumentation?: string | undefined;
  detail?: string;
  additionalTextEdits?: TextEdit[];
  filterText?: string;
}

export class CompletionProvider {
  private qidRegex = /[a-zA-Z0-9.]+/;
  private connection: Connection;
  private diagnostics: DiagnosticsProvider;

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
    this.diagnostics = container.resolve(DiagnosticsProvider);
    this.connection.onCompletion(
      this.diagnostics.interruptDiagnostics(() =>
        new ElmWorkspaceMatcher((params: CompletionParams) =>
          URI.parse(params.textDocument.uri),
        ).handle(this.handleCompletionRequest.bind(this)),
      ),
    );
  }

  protected handleCompletionRequest = (
    params: ICompletionParams,
  ): CompletionResult => {
    this.connection.console.info(`A completion was requested`);
    const completions: CompletionItem[] = [];

    const forest = params.program.getForest();
    const checker = params.program.getTypeChecker();
    const treeContainer = params.sourceFile;

    if (treeContainer) {
      const tree = treeContainer?.tree;

      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.position,
      );

      const nodeAtLineBefore = TreeUtils.getNamedDescendantForLineBeforePosition(
        tree.rootNode,
        params.position,
      );

      const nodeAtLineAfter = TreeUtils.getNamedDescendantForLineAfterPosition(
        tree.rootNode,
        params.position,
      );

      const targetLine = tree.rootNode.text.split("\n")[params.position.line];

      let currentCharacter = params.position.character;
      while (
        currentCharacter - 1 >= 0 &&
        this.qidRegex.test(targetLine[currentCharacter - 1])
      ) {
        currentCharacter--;
      }

      let replaceRange = Range.create(
        Position.create(params.position.line, currentCharacter),
        params.position,
      );

      const previousWord = this.findPreviousWord(currentCharacter, targetLine);

      const isAtStartOfLine = replaceRange.start.character === 0;

      let targetWord = targetLine.substring(
        replaceRange.start.character,
        replaceRange.end.character,
      );

      let contextNode = TreeUtils.findPreviousNode(
        tree.rootNode,
        params.position,
      );

      // If we are in a partial identifier, skip that and adjust the contextNode to be the previous node
      if (
        contextNode &&
        comparePosition(params.position, contextNode.endPosition) <= 0 &&
        TreeUtils.isIdentifier(contextNode)
      ) {
        contextNode = TreeUtils.findPreviousNode(
          tree.rootNode,
          PositionUtil.FROM_TS_POSITION(
            contextNode.startPosition,
          ).toVSPosition(),
        );
      }

      const isAfterDot = contextNode?.type === "dot";

      if (
        TreeUtils.findParentOfType("block_comment", nodeAtPosition) ||
        TreeUtils.findParentOfType("line_comment", nodeAtPosition)
      ) {
        // Don't complete in comments
        return [];
      } else if (
        isAtStartOfLine &&
        nodeAtLineBefore.type === "lower_case_identifier" &&
        nodeAtLineBefore.parent &&
        nodeAtLineBefore.parent.type === "type_annotation"
      ) {
        return [
          this.createCompletion({
            kind: CompletionItemKind.Text,
            label: nodeAtLineBefore.text,
            range: replaceRange,
            sortPrefix: "a",
          }),
        ];
      } else if (
        isAtStartOfLine &&
        nodeAtLineAfter.type === "lower_case_identifier" &&
        nodeAtLineAfter.parent &&
        (nodeAtLineAfter.parent.type === "value_qid" ||
          nodeAtLineAfter.parent.type === "function_declaration_left" ||
          nodeAtLineAfter.parent.type === "lower_pattern")
      ) {
        return [
          this.createCompletion({
            kind: CompletionItemKind.Text,
            label: `${nodeAtLineAfter.text} : `,
            range: replaceRange,
            sortPrefix: "a",
          }),
        ];
      } else if (isAtStartOfLine) {
        const topLevelFunctions = TreeUtils.findAllTopLevelFunctionDeclarations(
          tree,
        );

        const exposedValues = TreeUtils.descendantsOfType(
          tree.rootNode,
          "exposed_value",
        );

        const possibleMissingImplementations = TreeUtils.descendantsOfType(
          tree.rootNode,
          "function_call_expr",
        )
          .filter((a) => a.firstChild && !a.firstChild.text.includes("."))
          .filter(
            (a) =>
              !exposedValues.some(
                (b) => b.firstChild?.text === a.firstChild?.text,
              ),
          )
          .filter(
            (a) =>
              !topLevelFunctions?.some(
                (b) => b.firstChild?.text === a.firstChild?.text,
              ),
          );

        const snippetsFroMissingImplementations = possibleMissingImplementations.map(
          (a) =>
            this.createSnippet(
              "func " + a.firstChild!.text,
              [
                a.firstChild!.text + " : ${1:ArgumentType} -> ${2:ReturnType}",
                a.firstChild!.text + " ${3:arguments} =",
                "    ${4}",
              ],
              "Function with type annotation",
            ),
        );

        return [
          ...snippetsFroMissingImplementations,
          ...possibleMissingImplementations.map((a) =>
            this.createCompletion({
              kind: CompletionItemKind.Text,
              label: a.firstChild!.text,
              range: replaceRange,
              sortPrefix: "a",
            }),
          ), // Add plain text recommendations
          ...this.getKeywordsStartOfLine(),
          ...this.createSnippetsStartOfLine(),
        ];
      } else if (previousWord && previousWord === "module") {
        return undefined;
      } else if (
        nodeAtPosition.parent &&
        nodeAtPosition.parent.type === "module_declaration" &&
        nodeAtPosition &&
        nodeAtPosition.type === "exposing_list"
      ) {
        return this.getSameFileTopLevelCompletions(tree, replaceRange, true);
      } else if (
        nodeAtPosition.parent &&
        nodeAtPosition.parent.type === "exposing_list" &&
        nodeAtPosition.parent.parent &&
        nodeAtPosition.parent.parent.type === "module_declaration" &&
        nodeAtPosition &&
        (nodeAtPosition.type === "comma" ||
          nodeAtPosition.type === "right_parenthesis")
      ) {
        return this.getSameFileTopLevelCompletions(tree, replaceRange, true);
      } else if (
        nodeAtPosition.parent?.type === "exposing_list" &&
        nodeAtPosition.parent.parent?.type === "import_clause" &&
        nodeAtPosition.parent.firstNamedChild?.type === "exposing"
      ) {
        return this.getExposedFromModule(
          forest,
          nodeAtPosition.parent,
          replaceRange,
        );
      } else if (
        (nodeAtPosition.parent?.parent?.type === "exposing_list" &&
          nodeAtPosition.parent?.parent?.parent?.type === "import_clause" &&
          nodeAtPosition.parent?.parent.firstNamedChild?.type === "exposing") ||
        ((nodeAtPosition.type === "comma" ||
          nodeAtPosition.type === "right_parenthesis") &&
          nodeAtPosition.parent?.type === "ERROR" &&
          nodeAtPosition.parent?.parent?.type === "exposing_list")
      ) {
        return this.getExposedFromModule(
          forest,
          nodeAtPosition.parent.parent,
          replaceRange,
        );
      } else if (nodeAtPosition.parent?.parent?.type === "record_expr") {
        return this.getRecordCompletions(
          nodeAtPosition,
          treeContainer,
          replaceRange,
          params.program,
        );
      }

      let targetNode;

      if (contextNode) {
        const parent = contextNode.parent;
        if (isAfterDot) {
          targetWord = targetLine.substring(
            replaceRange.start.character,
            contextNode.startPosition.column,
          );

          replaceRange = Range.create(
            Position.create(
              params.position.line,
              contextNode.startPosition.column + 1,
            ),
            params.position,
          );

          if (parent?.type === "value_qid") {
            // Qualified submodule and value access
            targetNode = contextNode.previousNamedSibling;
          } else if (parent?.type === "field_access_expr") {
            // Record field access
            targetNode =
              contextNode?.previousNamedSibling?.lastNamedChild
                ?.lastNamedChild ??
              contextNode.previousNamedSibling?.lastNamedChild;
          } else if (parent?.type === "upper_case_qid") {
            // Imports
            targetNode = contextNode.previousNamedSibling;
          } else if (parent?.type === "ERROR") {
            targetNode = TreeUtils.findPreviousNode(
              tree.rootNode,
              PositionUtil.FROM_TS_POSITION(
                contextNode.startPosition,
              ).toVSPosition(),
            );
          }
        } else {
          if (contextNode.type === "import") {
            return this.getImportableModules(
              params.program,
              params.sourceFile,
              replaceRange,
            );
          }
        }
      }

      if (targetNode) {
        const moduleCompletions = this.getSubmodulesOrValues(
          targetNode,
          treeContainer,
          params.program,
          replaceRange,
          targetWord,
        );

        if (moduleCompletions.length > 0) {
          return moduleCompletions;
        }

        const recordCompletions = this.getRecordCompletions(
          targetNode,
          treeContainer,
          replaceRange,
          params.program,
        );

        if (recordCompletions.length > 0) {
          return recordCompletions;
        }

        return this.getRecordCompletionsUsingInference(
          checker,
          targetNode,
          replaceRange,
        );
      }

      completions.push(
        ...this.getSameFileTopLevelCompletions(tree, replaceRange),
      );
      completions.push(
        ...this.findDefinitionsForScope(nodeAtPosition, tree, replaceRange),
      );

      completions.push(
        ...this.getCompletionsFromOtherFile(
          checker,
          treeContainer,
          params.textDocument.uri,
          replaceRange,
          targetWord,
        ),
      );

      completions.push(...this.createSnippetsInline());
      completions.push(...this.getKeywordsInline());

      const possibleImportCompletions = this.getPossibleImports(
        params.program,
        replaceRange,
        tree,
        URI.parse(params.textDocument.uri),
        nodeAtPosition.text,
      );

      completions.push(...possibleImportCompletions.list);

      return {
        items: completions,
        isIncomplete: possibleImportCompletions.isIncomplete,
      };
    }
  };

  private findPreviousWord(
    currentCharacter: number,
    targetLine: string,
  ): string {
    currentCharacter--;
    const previousWordEnd = currentCharacter;
    while (
      currentCharacter - 1 >= 0 &&
      this.qidRegex.test(targetLine[currentCharacter - 1])
    ) {
      currentCharacter--;
    }
    return targetLine.slice(currentCharacter, previousWordEnd);
  }

  private getImportableModules(
    program: IElmWorkspace,
    sourceFile: ITreeContainer,
    range: Range,
    targetModule?: string,
  ): CompletionItem[] {
    return Array.from(sourceFile.project.moduleToUriMap.entries())
      .filter(
        ([moduleName]) =>
          (!targetModule || moduleName?.startsWith(targetModule + ".")) &&
          moduleName !== sourceFile.moduleName &&
          moduleName !== targetModule,
      )
      .map(([moduleName, uri]) => {
        const sourceFileToImport = program.getSourceFile(uri)!;
        const moduleNode = TreeUtils.findModuleDeclaration(
          sourceFileToImport.tree,
        );
        const markdownDocumentation = HintHelper.createHint(moduleNode);

        return this.createModuleCompletion({
          label:
            (targetModule
              ? moduleName?.slice(targetModule.length + 1) ?? moduleName
              : moduleName) ?? "",
          sortPrefix: "b",
          range,
          markdownDocumentation,
        });
      });
  }

  private getExposedFromModule(
    forest: IForest,
    exposingListNode: SyntaxNode,
    range: Range,
  ): CompletionItem[] | undefined {
    // Skip as clause to always get Module Name
    if (
      exposingListNode.previousNamedSibling &&
      exposingListNode.previousNamedSibling.type === "as_clause" &&
      exposingListNode.previousNamedSibling.previousNamedSibling
    ) {
      exposingListNode = exposingListNode.previousNamedSibling;
    }

    if (
      exposingListNode.previousNamedSibling &&
      exposingListNode.previousNamedSibling.type === "upper_case_qid"
    ) {
      const sortPrefix = "c";
      const moduleName = exposingListNode.previousNamedSibling.text;
      const exposedByModule = forest.getByModuleName(moduleName)?.exposing;
      if (exposedByModule) {
        return Array.from(exposedByModule.values())
          .map((a) => {
            const markdownDocumentation = HintHelper.createHint(a.syntaxNode);
            switch (a.type) {
              case "TypeAlias":
                return [
                  this.createTypeAliasCompletion({
                    markdownDocumentation,
                    label: a.name,
                    range,
                    sortPrefix,
                  }),
                ];
              case "Type":
                return a.exposedUnionConstructors
                  ? [
                      this.createTypeCompletion({
                        markdownDocumentation,
                        label: `${a.name}(..)`,
                        range,
                        sortPrefix,
                      }),
                      this.createTypeCompletion({
                        markdownDocumentation,
                        label: a.name,
                        range,
                        sortPrefix,
                      }),
                    ]
                  : [
                      this.createTypeCompletion({
                        markdownDocumentation,
                        label: a.name,
                        range,
                        sortPrefix,
                      }),
                    ];
              default:
                return [
                  this.createFunctionCompletion({
                    markdownDocumentation,
                    label: a.name,
                    range,
                    sortPrefix,
                  }),
                ];
            }
          })
          .reduce((a, b) => a.concat(b), []);
      }
    }
  }

  private getCompletionsFromOtherFile(
    checker: TypeChecker,
    treeContainer: ITreeContainer,
    uri: string,
    range: Range,
    inputText: string,
  ): CompletionItem[] {
    const completions: CompletionItem[] = [];

    checker.getAllImports(treeContainer).forEach((element): void => {
      const markdownDocumentation = HintHelper.createHint(element.node);
      let sortPrefix = "d";
      if (element.maintainerAndPackageName) {
        const matchedRanking: string = (RANKING_LIST as {
          [index: string]: string;
        })[element.maintainerAndPackageName];

        if (matchedRanking) {
          sortPrefix = `e${matchedRanking}`;
        }
      }

      const label = element.alias;
      let filterText = label;

      const dotIndex = label.lastIndexOf(".");
      const valuePart = label.slice(dotIndex + 1);

      const importNode = TreeUtils.findImportClauseByName(
        treeContainer.tree,
        element.fromModuleName,
      );

      // Check if a value is already imported for this module using the exposing list
      // In this case, we want to prefex the unqualified value since they are using the import exposing list
      const valuesAlreadyExposed =
        importNode &&
        !!TreeUtils.findFirstNamedChildOfType("exposing_list", importNode);

      // Try to determine if just the value is being typed
      if (
        !valuesAlreadyExposed &&
        valuePart.toLowerCase().startsWith(inputText.toLowerCase())
      ) {
        filterText = valuePart;
      }

      switch (element.type) {
        case "Function":
          completions.push(
            this.createFunctionCompletion({
              markdownDocumentation,
              label,
              range,
              sortPrefix,
              filterText,
            }),
          );
          break;
        case "UnionConstructor":
          completions.push(
            this.createUnionConstructorCompletion({
              label,
              range,
              sortPrefix,
              filterText,
            }),
          );
          break;
        case "Operator":
          completions.push(
            this.createOperatorCompletion({
              markdownDocumentation,
              label,
              range,
              sortPrefix,
            }),
          );
          break;
        case "Type":
          completions.push(
            this.createTypeCompletion({
              markdownDocumentation,
              label,
              range,
              sortPrefix,
              filterText,
            }),
          );
          break;
        case "TypeAlias":
          completions.push(
            this.createTypeAliasCompletion({
              markdownDocumentation,
              label,
              range,
              sortPrefix,
              filterText,
            }),
          );
          break;
        // Do not handle operators, they are not valid if prefixed
      }
    });

    completions.push(
      ...getEmptyTypes().map((a) =>
        this.createCompletion({
          markdownDocumentation: a.markdown,
          kind: a.symbolKind,
          label: a.name,
          range,
          sortPrefix: "d0000",
        }),
      ),
    );

    return completions;
  }

  private getSameFileTopLevelCompletions(
    tree: Tree,
    range: Range,
    moduleDefinition = false,
  ): CompletionItem[] {
    const completions: CompletionItem[] = [];
    const topLevelFunctions = TreeUtils.findAllTopLevelFunctionDeclarations(
      tree,
    );
    const sortPrefix = "b";
    // Add functions
    if (topLevelFunctions) {
      const declarations = topLevelFunctions.filter(
        (a) =>
          a.firstNamedChild !== null &&
          a.firstNamedChild.type === "function_declaration_left" &&
          a.firstNamedChild.firstNamedChild !== null &&
          a.firstNamedChild.firstNamedChild.type === "lower_case_identifier",
      );
      for (const declaration of declarations) {
        const markdownDocumentation = HintHelper.createHint(declaration);
        completions.push(
          this.createFunctionCompletion({
            markdownDocumentation,
            label: declaration.firstNamedChild!.firstNamedChild!.text,
            range,
            sortPrefix,
          }),
        );
      }
    }
    // Add types
    const typeDeclarations = TreeUtils.findAllTypeDeclarations(tree);
    if (typeDeclarations) {
      for (const declaration of typeDeclarations) {
        const markdownDocumentation = HintHelper.createHint(declaration);
        const name = TreeUtils.findFirstNamedChildOfType(
          "upper_case_identifier",
          declaration,
        );
        if (name) {
          completions.push(
            this.createTypeCompletion({
              markdownDocumentation,
              label: name.text,
              range,
              sortPrefix,
            }),
          );
          if (moduleDefinition) {
            completions.push(
              this.createTypeCompletion({
                markdownDocumentation,
                label: `${name.text}(..)`,
                range,
                sortPrefix,
              }),
            );
          }
        }
        // Add types constructors
        const unionVariants = TreeUtils.descendantsOfType(
          declaration,
          "union_variant",
        );
        for (const unionVariant of unionVariants) {
          const unionVariantName = TreeUtils.findFirstNamedChildOfType(
            "upper_case_identifier",
            unionVariant,
          );
          if (unionVariantName) {
            completions.push(
              this.createUnionConstructorCompletion({
                label: unionVariantName.text,
                range,
                sortPrefix,
              }),
            );
          }
        }
      }
    }
    // Add alias types
    const typeAliasDeclarations = TreeUtils.findAllTypeAliasDeclarations(tree);
    if (typeAliasDeclarations) {
      for (const declaration of typeAliasDeclarations) {
        const markdownDocumentation = HintHelper.createHint(declaration);
        const name = TreeUtils.findFirstNamedChildOfType(
          "upper_case_identifier",
          declaration,
        );
        if (name) {
          completions.push(
            this.createTypeAliasCompletion({
              markdownDocumentation,
              label: name.text,
              range,
              sortPrefix,
            }),
          );
        }
      }
    }

    return completions;
  }

  private getRecordCompletions(
    node: SyntaxNode,
    treeContainer: ITreeContainer,
    range: Range,
    elmWorkspace: IElmWorkspace,
  ): CompletionItem[] {
    const checker = elmWorkspace.getTypeChecker();

    const result: CompletionItem[] = [];
    let typeDeclarationNode = TreeUtils.getTypeAliasOfRecord(
      node,
      treeContainer,
      elmWorkspace,
    )?.node;

    if (!typeDeclarationNode && node.parent?.parent) {
      typeDeclarationNode = TreeUtils.getTypeAliasOfRecordField(
        node.parent.parent,
        treeContainer,
        elmWorkspace,
      )?.node;
    }

    let recordType: TRecord | undefined;
    if (!typeDeclarationNode && node.parent?.parent) {
      recordType = TreeUtils.getRecordTypeOfFunctionRecordParameter(
        node.parent.parent,
        elmWorkspace,
      );
    }

    if (
      !typeDeclarationNode &&
      !recordType &&
      node.parent?.parent?.type === "record_expr"
    ) {
      const recordExpr = node.parent.parent;

      const foundType = checker.findType(recordExpr);

      if (foundType.nodeType === "Record") {
        recordType = foundType;
      }
    }

    if (recordType) {
      if (recordType.baseType?.nodeType === "Record") {
        for (const field in recordType.baseType.fields) {
          const hint = HintHelper.createHintForTypeAliasReference(
            checker.typeToString(recordType.fields[field]),
            field,
            recordType.alias?.name ?? "",
          );

          result.push(
            this.createFieldOrParameterCompletion(hint, field, range),
          );
        }
      }
      for (const field in recordType.fields) {
        const hint = HintHelper.createHintForTypeAliasReference(
          checker.typeToString(recordType.fields[field]),
          field,
          recordType.alias?.name ?? "",
        );

        result.push(this.createFieldOrParameterCompletion(hint, field, range));
      }
    }

    if (typeDeclarationNode) {
      const fields = TreeUtils.getAllFieldsFromTypeAlias(typeDeclarationNode);

      const typeName =
        typeDeclarationNode.childForFieldName("name")?.text ?? "";

      fields?.forEach((element) => {
        const hint = HintHelper.createHintForTypeAliasReference(
          element.type,
          element.field,
          typeName,
        );
        result.push(
          this.createFieldOrParameterCompletion(hint, element.field, range),
        );
      });
    }

    return result;
  }

  private getRecordCompletionsUsingInference(
    checker: TypeChecker,
    targetNode: SyntaxNode,
    replaceRange: Range,
  ): CompletionItem[] {
    const result = [];
    const foundType = checker.findType(targetNode);

    if (foundType.nodeType === "Record") {
      for (const field in foundType.fields) {
        const hint = HintHelper.createHintForTypeAliasReference(
          checker.typeToString(foundType.fields[field]),
          field,
          foundType.alias?.name ?? "",
        );

        result.push(
          this.createFieldOrParameterCompletion(hint, field, replaceRange),
        );
      }
    }

    return result;
  }

  private createFunctionCompletion(
    options: ICompletionOptions,
  ): CompletionItem {
    options.kind = CompletionItemKind.Function;
    return this.createCompletion(options);
  }

  private createFieldOrParameterCompletion(
    markdownDocumentation: string | undefined,
    label: string,
    range: Range,
  ): CompletionItem {
    return this.createPreselectedCompletion(
      markdownDocumentation,
      CompletionItemKind.Field,
      label,
      range,
    );
  }

  private createTypeCompletion(options: ICompletionOptions): CompletionItem {
    options.kind = CompletionItemKind.Enum;
    return this.createCompletion(options);
  }

  private createTypeAliasCompletion(
    options: ICompletionOptions,
  ): CompletionItem {
    options.kind = CompletionItemKind.Struct;
    return this.createCompletion(options);
  }

  private createOperatorCompletion(
    options: ICompletionOptions,
  ): CompletionItem {
    options.kind = CompletionItemKind.Operator;
    return this.createCompletion(options);
  }

  private createUnionConstructorCompletion(
    options: ICompletionOptions,
  ): CompletionItem {
    options.kind = CompletionItemKind.EnumMember;
    return this.createCompletion(options);
  }

  private createModuleCompletion(options: ICompletionOptions): CompletionItem {
    options.kind = CompletionItemKind.Module;
    return this.createCompletion(options);
  }

  private createCompletion(options: ICompletionOptions): CompletionItem {
    return {
      documentation: options.markdownDocumentation
        ? {
            kind: MarkupKind.Markdown,
            value: options.markdownDocumentation ?? "",
          }
        : undefined,
      kind: options.kind,
      label: options.label,
      sortText: `${options.sortPrefix}_${options.label}`,
      textEdit: TextEdit.replace(options.range, options.label),
      detail: options.detail,
      additionalTextEdits: options.additionalTextEdits,
      filterText: options.filterText,
    };
  }

  private createPreselectedCompletion(
    markdownDocumentation: string | undefined,
    kind: CompletionItemKind,
    label: string,
    range: Range,
  ): CompletionItem {
    return {
      documentation: markdownDocumentation
        ? {
            kind: MarkupKind.Markdown,
            value: markdownDocumentation ?? "",
          }
        : undefined,
      kind,
      label,
      preselect: true,
      textEdit: TextEdit.replace(range, label),
    };
  }

  private findDefinitionsForScope(
    node: SyntaxNode,
    tree: Tree,
    range: Range,
  ): CompletionItem[] {
    const result: CompletionItem[] = [];
    const sortPrefix = "a";
    if (node.parent) {
      if (node.parent.type === "let_in_expr") {
        node.parent.children.forEach((nodeToProcess) => {
          if (
            nodeToProcess &&
            nodeToProcess.type === "value_declaration" &&
            nodeToProcess.firstNamedChild !== null &&
            nodeToProcess.firstNamedChild.type ===
              "function_declaration_left" &&
            nodeToProcess.firstNamedChild.firstNamedChild !== null &&
            nodeToProcess.firstNamedChild.firstNamedChild.type ===
              "lower_case_identifier"
          ) {
            const markdownDocumentation = HintHelper.createHintFromDefinitionInLet(
              nodeToProcess,
            );
            result.push(
              this.createFunctionCompletion({
                markdownDocumentation,
                label: nodeToProcess.firstNamedChild.firstNamedChild.text,
                range,
                sortPrefix,
              }),
            );
          }
        });
      }
      if (
        node.parent.type === "case_of_branch" &&
        node.parent.firstNamedChild &&
        node.parent.firstNamedChild.type === "pattern" &&
        node.parent.firstNamedChild.firstNamedChild &&
        node.parent.firstNamedChild.firstNamedChild.type === "union_pattern" &&
        node.parent.firstNamedChild.firstNamedChild.childCount > 1 // Ignore cases of case branches with no params
      ) {
        const caseBranchVariableNodes = TreeUtils.findAllNamedChildrenOfType(
          "lower_pattern",
          node.parent.firstNamedChild.firstNamedChild,
        );
        if (caseBranchVariableNodes) {
          caseBranchVariableNodes.forEach((a) => {
            const markdownDocumentation = HintHelper.createHintFromDefinitionInCaseBranch();
            result.push(
              this.createFunctionCompletion({
                markdownDocumentation,
                label: a.text,
                range,
                sortPrefix,
              }),
            );
          });
        }
      }
      if (
        node.parent.type === "value_declaration" &&
        node.parent.firstChild &&
        node.parent.firstChild.type === "function_declaration_left"
      ) {
        node.parent.firstChild.children.forEach((child) => {
          if (child.type === "lower_pattern") {
            const markdownDocumentation = HintHelper.createHintFromFunctionParameter(
              child,
            );
            result.push(
              this.createFieldOrParameterCompletion(
                markdownDocumentation,
                child.text,
                range,
              ),
            );

            const annotationTypeNode = TreeUtils.getTypeOrTypeAliasOfFunctionParameter(
              child,
            );
            if (annotationTypeNode) {
              const typeDeclarationNode = TreeUtils.findTypeAliasDeclaration(
                tree,
                annotationTypeNode.text,
              );
              if (typeDeclarationNode) {
                const fields = TreeUtils.getAllFieldsFromTypeAlias(
                  typeDeclarationNode,
                );
                if (fields) {
                  fields.forEach((element) => {
                    const hint = HintHelper.createHintForTypeAliasReference(
                      element.type,
                      element.field,
                      child.text,
                    );
                    result.push(
                      this.createFieldOrParameterCompletion(
                        hint,
                        `${child.text}.${element.field}`,
                        range,
                      ),
                    );
                  });
                }
              }
            }
          }
        });
      }
      result.push(...this.findDefinitionsForScope(node.parent, tree, range));
    }

    return result;
  }

  private getPossibleImportsFiltered(
    workspace: IElmWorkspace,
    uri: URI,
    filterText: string,
  ): IPossibleImport[] {
    const forest = workspace.getForest();
    const possibleImportsCache = workspace.getPossibleImportsCache();
    const treeContainer = forest.getByUri(uri);

    if (treeContainer) {
      const allImportedValues = workspace
        .getTypeChecker()
        .getAllImports(treeContainer);

      const importedModules =
        TreeUtils.findAllImportClauseNodes(treeContainer.tree)?.map(
          (n) => TreeUtils.findFirstNamedChildOfType("upper_case_qid", n)?.text,
        ) ?? [];

      const cached = possibleImportsCache.get(uri);
      const possibleImports =
        cached ?? ImportUtils.getPossibleImports(forest, uri);

      if (!cached) {
        possibleImportsCache.set(uri, possibleImports);
      }

      // Filter out already imported values
      // Then sort by startsWith filter text, then matches filter text
      return possibleImports
        .filter(
          (possibleImport): boolean =>
            !allImportedValues.get(
              possibleImport.valueToImport ?? possibleImport.value,
              (imp) => imp.fromModuleName === possibleImport.module,
            ),
        )
        .sort((a, b) => {
          const aValue = (a.valueToImport ?? a.value).toLowerCase();
          const bValue = (b.valueToImport ?? b.value).toLowerCase();

          filterText = filterText.toLowerCase();

          const aStartsWith = aValue.startsWith(filterText);
          const bStartsWith = bValue.startsWith(filterText);

          if (aStartsWith && !bStartsWith) {
            return -1;
          } else if (!aStartsWith && bStartsWith) {
            return 1;
          } else {
            const regex = new RegExp(escapeStringRegexp(filterText));
            const aMatches = regex.exec(aValue);
            const bMatches = regex.exec(bValue);

            if (aMatches && !bMatches) {
              return -1;
            } else if (!aMatches && bMatches) {
              return 1;
            } else {
              const aModuleImported = importedModules.includes(a.module);
              const bModuleImported = importedModules.includes(b.module);

              if (aModuleImported && !bModuleImported) {
                return -1;
              } else if (!aModuleImported && bModuleImported) {
                return 1;
              } else {
                return 0;
              }
            }
          }
        });
    }

    return [];
  }

  private getPossibleImports(
    workspace: IElmWorkspace,
    range: Range,
    tree: Tree,
    uri: URI,
    filterText: string,
  ): { list: CompletionItem[]; isIncomplete: boolean } {
    const result: CompletionItem[] = [];
    const possibleImports = this.getPossibleImportsFiltered(
      workspace,
      uri,
      filterText,
    );

    const isIncomplete = possibleImports.length > 50;

    possibleImports.splice(0, 49).forEach((possibleImport, i) => {
      const markdownDocumentation = HintHelper.createHint(possibleImport.node);
      const detail = `Auto import from module '${possibleImport.module}'`;
      const importTextEdit = RefactorEditUtils.addImport(
        tree,
        possibleImport.module,
        possibleImport.valueToImport ?? possibleImport.value,
      );

      const sortText = i < 10 ? `0${i}` : i;

      const completionOptions = {
        markdownDocumentation,
        label: possibleImport.value,
        range,
        sortPrefix: `f${sortText}`,
        detail,
        additionalTextEdits: importTextEdit ? [importTextEdit] : undefined,
      };
      if (possibleImport.type === "Function") {
        result.push(this.createFunctionCompletion(completionOptions));
      } else if (possibleImport.type === "TypeAlias") {
        result.push(this.createTypeAliasCompletion(completionOptions));
      } else if (possibleImport.type === "Type") {
        result.push(this.createTypeCompletion(completionOptions));
      } else if (possibleImport.type === "UnionConstructor") {
        result.push(
          this.createUnionConstructorCompletion({
            label: possibleImport.value,
            range,
            sortPrefix: `f${i}`,
            detail,
            additionalTextEdits: importTextEdit ? [importTextEdit] : undefined,
          }),
        );
      }
    });

    return { list: result, isIncomplete };
  }

  private getSubmodulesOrValues(
    node: SyntaxNode,
    sourceFile: ITreeContainer,
    program: IElmWorkspace,
    range: Range,
    targetModule: string,
  ): CompletionItem[] {
    const result: CompletionItem[] = [];

    const forest = program.getForest();
    const checker = program.getTypeChecker();
    const tree = sourceFile.tree;

    // Handle possible submodules
    result.push(
      ...this.getImportableModules(program, sourceFile, range, targetModule),
    );

    // If we are in an import completion, don't return any values
    if (TreeUtils.isImport(node)) {
      return result;
    }

    let alreadyImported = true;

    // Try to find the module definition that is already imported
    const definitionNode = checker.findDefinition(node, sourceFile);

    let moduleTree: ITreeContainer | undefined;

    if (definitionNode && definitionNode.nodeType === "Module") {
      moduleTree = program.getSourceFile(definitionNode.uri);
    } else {
      // Try to find this module in the forest to import
      moduleTree = forest.getByModuleName(targetModule);
      alreadyImported = false;
    }

    if (moduleTree) {
      // Get exposed values
      const imports = ImportUtils.getPossibleImportsOfTree(moduleTree);
      imports.forEach((value) => {
        const markdownDocumentation = HintHelper.createHint(value.node);
        let additionalTextEdits: TextEdit[] | undefined;
        let detail: string | undefined;

        // Add the import text edit if not imported
        if (!alreadyImported) {
          const importEdit = RefactorEditUtils.addImport(tree, targetModule);

          if (importEdit) {
            additionalTextEdits = [importEdit];
            detail = `Auto import module '${targetModule}'`;
          }
        }

        const completionOptions: ICompletionOptions = {
          label: value.value,
          sortPrefix: "a",
          range,
          markdownDocumentation,
          additionalTextEdits,
          detail,
        };

        switch (value.type) {
          case "Function":
            result.push(this.createFunctionCompletion(completionOptions));
            break;
          case "Type":
            result.push(this.createTypeCompletion(completionOptions));
            break;
          case "TypeAlias":
            result.push(this.createTypeAliasCompletion(completionOptions));
            break;
          case "UnionConstructor":
            result.push(
              this.createUnionConstructorCompletion(completionOptions),
            );
            break;
        }
      });
    }

    return result;
  }

  private createSnippet(
    label: string,
    snippetText: string | string[],
    markdownDocumentation?: string,
    kind?: CompletionItemKind,
  ): CompletionItem {
    return {
      documentation: markdownDocumentation
        ? {
            kind: MarkupKind.Markdown,
            value: markdownDocumentation ?? "",
          }
        : undefined,
      insertText: Array.isArray(snippetText)
        ? snippetText.join("\n")
        : snippetText,
      insertTextFormat: InsertTextFormat.Snippet,
      kind: kind ?? CompletionItemKind.Snippet,
      label,
      sortText: `s_${label}`,
    };
  }

  private createSnippetsInline(): CompletionItem[] {
    return [
      this.createSnippet(
        "of",
        ["of", "   $0"],
        "The of keyword",
        CompletionItemKind.Keyword,
      ),
      this.createSnippet(
        "case of",
        ["case ${1:expression} of$0"],
        "Case of expression ready to extend (you need to save first)",
      ),
      this.createSnippet(
        "if",
        [" if ${1:expression} then", "    ${2}", " else", "    ${3}"],
        "If-Else statement",
      ),
      this.createSnippet(
        "record update",
        ["{ ${1:recordName} | ${2:key} = ${3} }"],
        "Update record",
      ),
      this.createSnippet(
        "anonymous",
        ["\\ ${1:argument} -> ${1:argument}"],
        "Anonymous function",
      ),
      this.createSnippet(
        "let in",
        ["let", "    ${1}", "in", "${0}"],
        "Let expression",
      ),
    ];
  }

  private createSnippetsStartOfLine(): CompletionItem[] {
    return [
      this.createSnippet(
        "module",
        "module ${1:Name} exposing (${2:..})",
        "Module definition",
      ),
      this.createSnippet(
        "import",
        "import ${1:Name} exposing (${2:..})",
        "Unqualified import",
      ),
      this.createSnippet("comment", ["{-", "${0}", "-}"], "Multi-line comment"),
      this.createSnippet(
        "record",
        [
          "${1:recordName} =",
          "    { ${2:key1} = ${3:value1}",
          "    , ${4:key2} = ${5:value2}",
          "    }",
        ],
        "Record",
      ),
      this.createSnippet(
        "type alias",
        [
          "type alias ${1:recordName} =",
          "    { ${2:key1} : ${3:ValueType1}",
          "    , ${4:key2} : ${5:ValueType2}",
          "    }",
        ],
        "Type alias",
      ),
      this.createSnippet(
        "type",
        ["type ${1:Typename}", "    = ${2:Value1}", "    | ${3:Value2}"],
        "Custom type",
      ),
      this.createSnippet(
        "msg",
        ["type Msg", "    = ${1:Message}", "    | ${2:Message}"],
        "Default message custom type",
      ),
      this.createSnippet(
        "func",
        [
          "${1:functionName} : ${2:ArgumentType} -> ${3:ReturnType}",
          "${1:functionName} ${4:arguments} =",
          "    ${5}",
        ],
        "Function with type annotation",
      ),
      this.createSnippet(
        "update",
        [
          "update : Msg -> Model -> ${1|Model, ( Model\\, Cmd Msg )|}",
          "update msg model =",
          "    case msg of",
          "        ${2:option1} ->",
          "            ${1|Model, ( Model\\, Cmd Msg )|}",
          "",
          "        ${3:option2} ->",
          "            ${1|Model, ( Model\\, Cmd Msg )|}",
        ],
        "Default update function",
      ),
      this.createSnippet(
        "view",
        ["view : Model -> Html Msg", "view model =", "    ${0}"],
        "Default view function",
      ),
      this.createSnippet(
        "port in",
        ["port ${1:portName} : (${2:Typename} -> msg) -> Sub msg"],
        "Incoming port",
      ),
      this.createSnippet(
        "port out",
        ["port ${1:portName} : ${2:Typename} -> Cmd msg"],
        "Outgoing port",
      ),
      this.createSnippet(
        "main sandbox",
        [
          "main : Program () Model Msg",
          "main =",
          "    Browser.sandbox",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        }",
        ],
        "Main Browser Sandbox",
      ),
      this.createSnippet(
        "main element",
        [
          "main : Program () Model Msg",
          "main =",
          "    Browser.element",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "        }",
        ],
        "Main Browser Element",
      ),
      this.createSnippet(
        "main document",
        [
          "main : Program () Model Msg",
          "main =",
          "    Browser.document",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "        }",
        ],
        "Main Browser Document",
      ),
      this.createSnippet(
        "main application",
        [
          "main : Program () Model Msg",
          "main =",
          "    Browser.application",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "        , onUrlChange = onUrlChange",
          "        , onUrlRequest = onUrlRequest",
          "        }",
        ],
        "Main Browser Application",
      ),
      this.createSnippet(
        "subscriptions",
        [
          "subscriptions : Model -> Sub Msg",
          "subscriptions model =",
          "    Sub.none",
        ],
        "Subscriptions",
      ),
      this.createSnippet(
        "default model",
        [
          "type alias Model =",
          "    { statusText : String",
          "    }",
          "",
          "",
          "model : Model",
          "model =",
          '    { statusText = "Ready"',
          "    }",
        ],
        "A default model with type declaration",
      ),
      this.createSnippet(
        "Browser.sandbox",
        [
          "module Main exposing (Model, Msg, update, view, init)",
          "",
          "import Html exposing (..)",
          "import Browser",
          "",
          "",
          "main : Program () Model Msg",
          "main =",
          "    Browser.sandbox",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "    }",
          "",
          "",
          "type alias Model =",
          "    { ${1:property} : ${2:propertyType}",
          "    }",
          "",
          "",
          "init : Model",
          "init =",
          "    Model ${3:modelInitialValue}",
          "",
          "",
          "type Msg",
          "    = ${4:Msg1}",
          "    | ${5:Msg2}",
          "",
          "",
          "update : Msg -> Model -> Model",
          "update msg model =",
          "    case msg of",
          "        ${6:Msg1} ->",
          "            model",
          "",
          "        ${7:Msg2} ->",
          "            model",
          "",
          "",
          "view : Model -> Html Msg",
          "view model =",
          "    div []",
          '        [ text "New Sandbox" ]',
          "",
          "",
          "${0}",
        ],
        "Browser Sandbox",
      ),
      this.createSnippet(
        "Browser.element",
        [
          "module Main exposing (Model, Msg, update, view, subscriptions, init)",
          "",
          "import Html exposing (..)",
          "import Browser",
          "",
          "",
          "main : Program flags Model Msg",
          "main =",
          "    Browser.element",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "    }",
          "",
          "",
          "type alias Model =",
          "    { key : Nav.Key",
          "    , url : Url.Url",
          "    , property : propertyType",
          "    }",
          "",
          "",
          "init : flags -> (Model, Cmd Msg)",
          "init flags =",
          "    (Model modelInitialValue, Cmd.none)",
          "",
          "",
          "type Msg",
          "    = ${1:Msg1}",
          "    | ${2:Msg2}",
          "",
          "",
          "update : Msg -> Model -> (Model, Cmd Msg)",
          "update msg model =",
          "    case msg of",
          "        ${1:Msg1} ->",
          "            (model, Cmd.none)",
          "",
          "        ${2:Msg2} ->",
          "            (model, Cmd.none)",
          "",
          "",
          "subscriptions : Model -> Sub Msg",
          "subscriptions model =",
          "    Sub.none",
          "",
          "",
          "view : Model -> Html Msg",
          "view model =",
          "    div []",
          '        [ text "New Element" ]',
          "",
          "",
          "${0}",
        ],
        "Browser Element",
      ),
      this.createSnippet(
        "Browser.document",
        [
          "module Main exposing (Model, Msg, update, view, subscriptions, init)",
          "",
          "import Html exposing (..)",
          "import Browser",
          "",
          "",
          "main : Program flags Model Msg",
          "main =",
          "    Browser.document",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "    }",
          "",
          "",
          "type alias Model =",
          "    { property : propertyType",
          "    }",
          "",
          "",
          "init : flags -> (Model, Cmd Msg)",
          "init flags =",
          "    (Model modelInitialValue, Cmd.none)",
          "",
          "",
          "type Msg",
          "    = ${1:Msg1}",
          "    | ${2:Msg2}",
          "",
          "",
          "update : Msg -> Model -> (Model, Cmd Msg)",
          "update msg model =",
          "    case msg of",
          "        ${1:Msg1} ->",
          "            (model, Cmd.none)",
          "",
          "        ${2:Msg2} ->",
          "            (model, Cmd.none)",
          "",
          "",
          "subscriptions : Model -> Sub Msg",
          "subscriptions model =",
          "    Sub.none",
          "",
          "",
          "view : Model -> Browser.Document Msg",
          "view model =",
          '    { title = "Document Title"',
          "    , body =",
          "        [ div []",
          '            [ text "New Document" ]',
          "      ]",
          "    }",
          "",
          "",
          "${0}",
        ],
        "Browser Document",
      ),
      this.createSnippet(
        "Browser.application",
        [
          "module Main exposing (Model, init, Msg, update, view, subscriptions)",
          "",
          "import Html exposing (..)",
          "import Browser",
          "import Browser.Navigation as Nav",
          "import Url",
          "",
          "",
          "main : Program flags Model Msg",
          "main =",
          "    Browser.application",
          "        { init = init",
          "        , view = view",
          "        , update = update",
          "        , subscriptions = subscriptions",
          "        , onUrlRequest = UrlRequested",
          "        , onUrlChange = UrlChanged",
          "    }",
          "",
          "",
          "type alias Model =",
          "    { key : Nav.Key",
          "    , url : Url.Url",
          "    , property : propertyType",
          "    }",
          "",
          "",
          "init : flags -> Url.Url -> Nav.Key -> (Model, Cmd Msg)",
          "init flags url key =",
          "    (Model modelInitialValue, Cmd.none)",
          "",
          "",
          "type Msg",
          "    = ${1:Msg1}",
          "    | ${2:Msg2}",
          "    | UrlRequested Browser.UrlRequest",
          "    | UrlChanged Url.Url",
          "",
          "",
          "update : Msg -> Model -> (Model, Cmd Msg)",
          "update msg model =",
          "    case msg of",
          "        ${1:Msg1} ->",
          "            (model, Cmd.none)",
          "",
          "        ${2:Msg2} ->",
          "            (model, Cmd.none)",
          "",
          "        UrlRequested urlRequest ->",
          "            case urlRequest of",
          "                Browser.Internal url ->",
          "                    ( model, Nav.pushUrl model.key (Url.toString url) )",
          "",
          "                Browser.External href ->",
          "                    ( model, Nav.load href )",
          "",
          "        UrlChanged url ->",
          "            ( { model | url = url }",
          "            , Cmd.none",
          "            )",
          "",
          "",
          "subscriptions : Model -> Sub Msg",
          "subscriptions model =",
          "    Sub.none",
          "",
          "",
          "view : Model -> Browser.Document Msg",
          "view model =",
          '    { title = "Application Title"',
          "    , body =",
          "        [ div []",
          '            [ text "New Application" ]',
          "      ]",
          "    }",
          "",
          "",
          "${0}",
        ],
        "Browser Application",
      ),
      this.createSnippet(
        "describe",
        ['describe "${1:name}"', "    [ ${0}", "    ]"],
        "Describe block in Elm-test",
      ),
      this.createSnippet(
        "test",
        ['test "${1:name}" <|', "    \\_ ->", "        ${0}"],
        "Test block in Elm-test",
      ),
      this.createSnippet("todo", "-- TODO: ${0}", "TODO comment"),
    ];
  }

  private createKeywordCompletion(label: string): CompletionItem {
    return {
      label,
      kind: CompletionItemKind.Keyword,
      sortText: `a_${label}`,
    };
  }

  private getKeywordsInline(): CompletionItem[] {
    return [
      this.createKeywordCompletion("if"),
      this.createKeywordCompletion("then"),
      this.createKeywordCompletion("else"),
      this.createKeywordCompletion("let"),
      this.createKeywordCompletion("in"),
      this.createKeywordCompletion("case"),
      this.createKeywordCompletion("alias"),
      this.createKeywordCompletion("exposing"),
    ];
  }

  private getKeywordsStartOfLine(): CompletionItem[] {
    return [
      this.createKeywordCompletion("type"),
      this.createKeywordCompletion("import"),
      this.createKeywordCompletion("module"),
      this.createKeywordCompletion("port"),
    ];
  }
}
