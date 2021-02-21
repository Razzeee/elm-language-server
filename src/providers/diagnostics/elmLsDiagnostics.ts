/* eslint-disable @typescript-eslint/no-unsafe-call */
import { ISourceFile } from "../../compiler/forest";
import { container } from "tsyringe";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Connection,
  DiagnosticSeverity,
  DiagnosticTag,
  Position,
  Range,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import {
  Language,
  Parser,
  Query,
  QueryResult,
  SyntaxNode,
  Tree,
} from "web-tree-sitter";
import { IProgram } from "../../compiler/program";
import { PositionUtil } from "../../positionUtil";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { RefactorEditUtils } from "../../util/refactorEditUtils";
import { TreeUtils } from "../../util/treeUtils";
import { Utils } from "../../util/utils";
import { IDiagnostic } from "./diagnosticsProvider";
import * as path from "path";
import { SyntaxNodeMap } from "../../compiler/utils/syntaxNodeMap";

interface IElmAnalyseJson {
  checks?: {
    BooleanCase?: boolean;
    DebugLog?: boolean; // We don't support this
    DebugTodo?: boolean; // We don't support this
    DropConcatOfLists?: boolean;
    DropConsOfItemAndList?: boolean;
    DuplicateImport?: boolean; // We don't support this as elm-format will fix this
    DuplicateImportedVariable?: boolean; // We don't support this as elm-format will fix this
    ExposeAll?: boolean; // We don't support this
    FileLoadFailed?: boolean; // We don't support this as it makes no sense for us
    NoUncurriedPrefix?: boolean;
    FunctionInLet?: boolean; // We don't support this
    ImportAll?: boolean; // We don't support this
    MapNothingToNothing?: boolean;
    MultiLineRecordFormatting?: boolean; // We don't support this
    NoTopLevelSignature?: boolean; // We don't support this as we get it via type inference already
    SingleFieldRecord?: boolean;
    TriggerWords?: string[]; // We don't support this
    UnnecessaryListConcat?: boolean;
    UnnecessaryParens?: boolean; // We don't support this as elm-format will fix these anyway
    UnnecessaryPortModule?: boolean;
    UnusedImport?: boolean;
    UnusedImportAlias?: boolean;
    UnusedImportedVariable?: boolean;
    UnusedPatternVariable?: boolean;
    UnusedTopLevel?: boolean;
    UnusedTypeAlias?: boolean;
    UnusedValueConstructor?: boolean;
    UnusedVariable?: boolean;
    UseConsOverConcat?: boolean;
  };
  excludedPaths?: string[];
}
export class ElmLsDiagnostics {
  private language: Language;
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private connection: Connection;
  private elmAnalyseJson = new Map<string, IElmAnalyseJson>();

  private readonly exposedValuesAndTypesQuery: Query;
  private readonly exposedValueAndTypeUsagesQuery: Query;
  private readonly moduleImportsQuery: Query;
  private readonly moduleReferencesQuery: Query;
  private readonly importModuleAliasesQuery: Query;
  private readonly moduleAliasReferencesQuery: Query;
  private readonly patternsQuery: Query;
  private readonly caseBranchesQuery: Query;
  private readonly booleanCaseExpressionsQuery: Query;
  private readonly concatOfListsQuery: Query;
  private readonly consOfItemAndListQuery: Query;
  private readonly useConsOverConcatQuery: Query;
  private readonly singleFieldRecordTypesQuery: Query;
  private readonly unnecessaryListConcatQuery: Query;
  private readonly unusedPortModuleQuery: Query;
  private readonly operatorFunctionsQuery: Query;
  private readonly typeAliasesQuery: Query;
  private readonly typeAliasUsagesQuery: Query;
  private readonly unionVariantsQuery: Query;
  private readonly unionVariantUsagesQuery: Query;
  private readonly patternReferencesQuery: Query;

  constructor() {
    this.language = container.resolve<Parser>("Parser").getLanguage();
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
    this.connection = container.resolve<Connection>("Connection");

    this.exposedValuesAndTypesQuery = this.language.query(
      `
        (import_clause
          (exposing_list
            (exposed_value) @exposedValue
          )
        )
        (import_clause
          (exposing_list
            (exposed_type) @exposedType
          )
        )
      `,
    );

    this.exposedValueAndTypeUsagesQuery = this.language.query(
      `
      (
        [
          (value_expr)
          (record_base_identifier)
        ] @value.reference
      )
      ((type_ref
        (upper_case_qid) @type.reference)
      )
      `,
    );

    this.moduleImportsQuery = this.language.query(
      `
        (import_clause
          (upper_case_qid) @moduleName
        )
    `,
    );

    this.moduleReferencesQuery = this.language.query(
      `
        (value_qid
          (
            (upper_case_identifier)
            (dot)
          )* @module.reference
        )
        (upper_case_qid
          (
            (upper_case_identifier)
            (dot)
          )* @module.reference
        )
      `,
    );

    this.importModuleAliasesQuery = this.language.query(
      `
        (import_clause
          (as_clause
            (upper_case_identifier) @moduleAlias
          )
        )
      `,
    );

    this.moduleAliasReferencesQuery = this.language.query(
      `
        (value_qid
          (
            (upper_case_identifier)
            (dot)
          )* @module.reference
        )
        (upper_case_qid
          (
            (upper_case_identifier)
            (dot)
          )* @module.reference
        )
      `,
    );

    this.patternsQuery = this.language.query(
      `
        (value_declaration
          (function_declaration_left
            [
              (pattern)
              (record_pattern)
              (lower_pattern)
            ] @pattern
          )
        ) @patternScope

        ; For some reason, we can match on the let_in_expr
        (value_declaration
          [
            (pattern)
            (record_pattern)
          ] @pattern
        ) @patternScope

        ; For let expr variables
        (value_declaration
          (function_declaration_left
            (lower_case_identifier) @pattern
          )
        ) @patternScope

        (case_of_branch
          (pattern) @pattern
        ) @patternScope

        (anonymous_function_expr
          (pattern) @pattern
        ) @patternScope
      `,
    );

    this.caseBranchesQuery = this.language.query(
      `
        (
          (case_of_branch
            (pattern) @casePattern
            (value_expr) @caseValue
          ) @caseBranch
          (#eq? @casePattern "Nothing")
          (#eq? @caseValue "Nothing")
        )
      `,
    );

    this.booleanCaseExpressionsQuery = this.language.query(
      `
        (
          (case_of_branch
            pattern: (pattern) @casePattern1
            (#match? @casePattern1 "^(True|False)$")
          ) @caseBranch
          (case_of_branch
            pattern: (pattern) @casePattern2
            (#match? @casePattern2 "^(True|False|_)$")
          )
        )
      `,
    );

    this.concatOfListsQuery = this.language.query(
      `
        (
          (list_expr) @startList
          .
          (operator
            (operator_identifier
              "++"
            )
          )
          .
          (list_expr) @endList
        )
      `,
    );

    this.consOfItemAndListQuery = this.language.query(
      `
        (bin_op_expr
          (_) @itemExpr
          .
          (operator
            (operator_identifier
              "::"
            )
          )
          .
          (list_expr) @listExpr
        )
      `,
    );

    this.useConsOverConcatQuery = this.language.query(
      `
        (bin_op_expr
          (list_expr
            .
            (_)
            .
          ) @firstPart
          .
          (operator
            (operator_identifier
              "++"
            )
          )
          .
          (_) @lastPart
        )
      `,
    );

    this.singleFieldRecordTypesQuery = this.language.query(
      `
        (record_type
          .
          (_)
          .
        ) @recordType
      `,
    );

    this.unnecessaryListConcatQuery = this.language.query(
      `
        (
          (function_call_expr
            target: (_) @target
            arg: (list_expr
              .
              (list_expr)
              .
              ((comma) . (list_expr))*
              .
            )
          ) @functionCall
          (#eq? @target "List.concat")
        )
      `,
    );

    this.unusedPortModuleQuery = this.language.query(
      `
        (module_declaration
          (port)
        ) @portModule

        (port_annotation) @portAnnotation
        `,
    );

    this.operatorFunctionsQuery = this.language.query(
      `
        (function_call_expr
          target: (operator_as_function_expr)
          .
          (_) @arg1
          .
          (_) @arg2
        ) @functionCall
        `,
    );

    this.typeAliasesQuery = this.language.query(
      `
        (type_alias_declaration
          (upper_case_identifier) @typeAlias
        )
        `,
    );

    this.typeAliasUsagesQuery = this.language.query(
      `
        (
          [
            (value_expr)
            (exposed_type)
          ] @value.reference
        )
        ((type_ref
          (upper_case_qid) @type.reference)
        )
        `,
    );

    this.unionVariantsQuery = this.language.query(
      `
        (type_declaration
          (upper_case_identifier) @typeName
          (union_variant
            (upper_case_identifier) @unionVariant
          )
        )
        `,
    );

    this.unionVariantUsagesQuery = this.language.query(
      `
      (
        (exposed_type) @exposed.reference
      )
      (
        (value_expr) @value.reference
      )
      ((type_ref
        (upper_case_qid) @type.reference)
      )
      ((case_of_branch
        (pattern
          (union_pattern
            (upper_case_qid) @variant.reference)))
      )
      `,
    );

    this.patternReferencesQuery = this.language.query(
      `
        (
          [
            (value_expr)
            (record_base_identifier)
            (exposed_value)
          ] @patternVariable.reference
        )
        (
          (module_declaration
            (exposing_list
              (double_dot)
            ) @exposingAll
          )
        )
        `,
    );
  }

  public createDiagnostics = (
    sourceFile: ISourceFile,
    program: IProgram,
  ): IDiagnostic[] => {
    const elmAnalyseJson = this.getElmAnalyseJson(program.getRootPath().fsPath);
    const tree = sourceFile.tree;
    const uri = sourceFile.uri;

    if (
      elmAnalyseJson.excludedPaths?.some((path) =>
        uri.startsWith(URI.file(path).toString()),
      )
    ) {
      return [];
    }

    try {
      return [
        ...(elmAnalyseJson.checks?.UnusedImport === false
          ? []
          : this.getUnusedImportDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnusedImportedVariable === false
          ? []
          : this.getUnusedImportValueAndTypeDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnusedImportAlias === false
          ? []
          : this.getUnusedImportAliasDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnusedPatternVariable === false
          ? []
          : this.getUnusedPatternVariableDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.MapNothingToNothing === false
          ? []
          : this.getCaseBranchMapNothingToNothingDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.BooleanCase === false
          ? []
          : this.getBooleanCaseExpressionDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.DropConcatOfLists === false
          ? []
          : this.getDropConcatOfListsDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.DropConsOfItemAndList === false
          ? []
          : this.getDropConsOfItemAndListDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UseConsOverConcat === false
          ? []
          : this.getUseConsOverConcatDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.SingleFieldRecord === false
          ? []
          : this.getSingleFieldRecordDiagnostics(tree, uri, program)),
        ...(elmAnalyseJson.checks?.UnnecessaryListConcat === false
          ? []
          : this.getUnnecessaryListConcatDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnnecessaryPortModule === false
          ? []
          : this.getUnnecessaryPortModuleDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.NoUncurriedPrefix === false
          ? []
          : this.getFullyAppliedOperatorAsPrefixDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnusedTypeAlias === false
          ? []
          : this.getUnusedTypeAliasDiagnostics(tree)),
        ...(elmAnalyseJson.checks?.UnusedValueConstructor === false
          ? []
          : this.getUnusedValueConstructorDiagnostics(tree)),
      ];
    } catch (e) {
      this.connection.console.error(e);
    }
    return [];
  };

  private getElmAnalyseJson(workspacePath: string): IElmAnalyseJson {
    const cached = this.elmAnalyseJson.get(workspacePath);

    if (cached) {
      return cached;
    }

    let elmAnalyseJson = {};
    try {
      elmAnalyseJson = require(path.join(
        workspacePath,
        "elm-analyse.json",
      )) as IElmAnalyseJson;
    } catch {
      this.connection.console.info(
        "No elm-analyse.json found, enabling all diagnostic checks.",
      );
    }

    this.elmAnalyseJson.set(workspacePath, elmAnalyseJson);
    return elmAnalyseJson;
  }

  public onCodeAction(params: CodeActionParams): CodeAction[] {
    const { uri } = params.textDocument;
    const elmDiagnostics: IDiagnostic[] = params.context.diagnostics.filter(
      (diagnostic) => diagnostic.source === "ElmLS",
    ) as IDiagnostic[];

    return this.convertDiagnosticsToCodeActions(elmDiagnostics, uri);
  }

  private convertDiagnosticsToCodeActions(
    diagnostics: IDiagnostic[],
    uri: string,
  ): CodeAction[] {
    const result: CodeAction[] = [];

    const program = this.elmWorkspaceMatcher.getProgramFor(URI.parse(uri));

    const forest = program.getForest();

    const sourceFile = forest.getByUri(uri);

    if (sourceFile) {
      diagnostics.forEach((diagnostic) => {
        if (diagnostic.data.code === "unused_imported_value") {
          const node = TreeUtils.getNamedDescendantForPosition(
            sourceFile.tree.rootNode,
            diagnostic.range.start,
          );

          const importClause = TreeUtils.findParentOfType(
            "import_clause",
            node,
          );

          if (!importClause) {
            return;
          }

          const moduleName = TreeUtils.findFirstNamedChildOfType(
            "upper_case_qid",
            importClause,
          );

          if (!moduleName) {
            return;
          }

          const removeValueEdit = RefactorEditUtils.removeValueFromImport(
            sourceFile.tree,
            moduleName.text,
            node.text,
          );

          if (removeValueEdit) {
            result.push({
              diagnostics: [diagnostic],
              edit: {
                changes: {
                  [uri]: [removeValueEdit],
                },
              },
              kind: CodeActionKind.QuickFix,
              title: `Remove unused ${
                node.type === "exposed_type" ? "type" : "value"
              } \`${node.text}\``,
            });
          }
        }

        if (diagnostic.data.code === "unused_import") {
          const node = TreeUtils.getNamedDescendantForPosition(
            sourceFile.tree.rootNode,
            diagnostic.range.end,
          );

          const moduleName = node.childForFieldName("moduleName");

          result.push({
            diagnostics: [diagnostic],
            edit: {
              changes: {
                [uri]: [
                  TextEdit.del(
                    Range.create(
                      diagnostic.range.start,
                      Position.create(diagnostic.range.end.line + 1, 0),
                    ),
                  ),
                ],
              },
            },
            kind: CodeActionKind.QuickFix,
            title: `Remove unused import \`${moduleName?.text ?? node.text}\``,
          });
        }

        if (diagnostic.data.code === "unused_alias") {
          const node = TreeUtils.getNamedDescendantForPosition(
            sourceFile.tree.rootNode,
            diagnostic.range.end,
          );

          result.push({
            diagnostics: [diagnostic],
            edit: {
              changes: { [uri]: [TextEdit.del(diagnostic.range)] },
            },
            kind: CodeActionKind.QuickFix,
            title: `Remove unused alias \`${node.text}\``,
          });
        }

        if (diagnostic.data.code === "unused_pattern") {
          const node = TreeUtils.getNamedDescendantForPosition(
            sourceFile.tree.rootNode,
            diagnostic.range.start,
          );

          const edit =
            node.parent?.parent?.type === "record_pattern"
              ? RefactorEditUtils.removeRecordPatternValue(node.parent)
              : TextEdit.replace(diagnostic.range, "_");

          result.push({
            diagnostics: [diagnostic],
            edit: {
              changes: { [uri]: [edit] },
            },
            kind: CodeActionKind.QuickFix,
            title: `Fix unused pattern \`${node.text}\``,
          });
        }
      });
    }
    return result;
  }

  private getUnusedImportDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const moduleImports = this.moduleImportsQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node)
      .filter((node) => !node.parent?.childForFieldName("exposing"))
      .map((node) => {
        const alias = node.parent
          ?.childForFieldName("asClause")
          ?.childForFieldName("name");

        return alias ? alias : node;
      });

    const moduleReferences = this.moduleReferencesQuery
      .matches(tree.rootNode)
      .filter(Utils.notUndefined.bind(this))
      .filter(
        (match) =>
          match.captures.length > 0 &&
          match.captures[0].node.parent?.type !== "import_clause",
      )
      .map((match) => match.captures.map((n) => n.node.text).join("."));

    // Would need to adjust tree-sitter (use fields) to get a better query
    moduleImports.forEach((moduleImport) => {
      const references = moduleReferences.filter(
        (moduleReference) => moduleReference === moduleImport.text,
      );

      const importNode =
        moduleImport.parent?.type === "as_clause"
          ? moduleImport.parent?.parent
          : moduleImport.parent;
      if (references.length === 0 && importNode) {
        diagnostics.push({
          range: this.getNodeRange(importNode),
          message: `Unused import \`${moduleImport.text}\``,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          tags: [DiagnosticTag.Unnecessary],
          data: { uri: tree.uri, code: "unused_import" },
        });
      }
    });

    return diagnostics;
  }

  private getUnusedImportValueAndTypeDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const exposedValuesAndTypes = this.exposedValuesAndTypesQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node);

    const allUsages = this.exposedValueAndTypeUsagesQuery
      .matches(tree.rootNode)
      .filter(Utils.notUndefined.bind(this));
    exposedValuesAndTypes.forEach((exposedValueOrType) => {
      if (exposedValueOrType.text.endsWith("(..)")) {
        return;
      }

      const references = allUsages.filter(
        (result) => result.captures[0].node.text === exposedValueOrType.text,
      );

      if (references.length === 0) {
        diagnostics.push({
          range: this.getNodeRange(exposedValueOrType),
          message: `Unused imported ${
            exposedValueOrType.type === "exposed_type" ? "type" : "value"
          } \`${exposedValueOrType.text}\``,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          tags: [DiagnosticTag.Unnecessary],
          data: { uri: tree.uri, code: "unused_imported_value" },
        });
      }
    });

    return diagnostics;
  }

  private getUnusedImportAliasDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const moduleAliases = this.importModuleAliasesQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node);

    const allAliasReferences = this.moduleAliasReferencesQuery
      .matches(tree.rootNode)
      .filter(Utils.notUndefined.bind(this))
      .filter((match) => match.captures.length > 0)
      .map((match) => match.captures[0].node.text);

    moduleAliases.forEach((moduleAlias) => {
      // This case is handled by unused_import
      if (!moduleAlias.parent?.parent?.childForFieldName("exposing")) {
        return;
      }

      const references = allAliasReferences.filter(
        (moduleReference) => moduleReference === moduleAlias.text,
      );

      if (references.length === 0 && moduleAlias.parent) {
        diagnostics.push({
          range: this.getNodeRange(moduleAlias.parent),
          message: `Unused import alias \`${moduleAlias.text}\``,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          tags: [DiagnosticTag.Unnecessary],
          data: { uri: tree.uri, code: "unused_alias" },
        });
      }
    });

    return diagnostics;
  }

  private getUnusedPatternVariableDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const patternMatches = this.patternsQuery.matches(tree.rootNode);

    const scopeCache = new SyntaxNodeMap<SyntaxNode, QueryResult[]>();

    patternMatches
      .filter(Utils.notUndefined.bind(this))
      .flatMap((match) => {
        let scope = match.captures[0].node;
        const patternMatch = match.captures[1].node;

        // Adjust the scope of let_in_expr due to the query bug above
        if (
          scope.type === "value_declaration" &&
          scope.parent?.type === "let_in_expr" &&
          (patternMatch.type === "lower_case_identifier" ||
            patternMatch.parent?.type === "value_declaration")
        ) {
          scope = scope.parent;
        }

        if (
          patternMatch.type === "lower_case_identifier" &&
          scope.parent?.type === "file"
        ) {
          scope = scope.parent;
        }

        return patternMatch.type === "lower_pattern" ||
          patternMatch.type === "lower_case_identifier"
          ? [{ scope, pattern: patternMatch }]
          : patternMatch.descendantsOfType("lower_pattern").map((pattern) => {
              return { scope, pattern };
            });
      })
      .forEach(({ scope, pattern }) => {
        const references = scopeCache
          .getOrSet(scope, () =>
            this.patternReferencesQuery
              .matches(scope)
              .filter(Utils.notUndefined.bind(this)),
          )
          .filter(
            (result) =>
              result.captures[0].name !== "patternVariable.reference" ||
              result.captures[0].node.text === pattern.text,
          );

        if (scope.type === "file") {
          let outsideRef = false;
          const topLevelDeclaration = TreeUtils.findParentOfType(
            "value_declaration",
            pattern,
          );

          for (const ref of references) {
            const valueDeclaration = TreeUtils.findParentOfType(
              "value_declaration",
              ref.captures[0].node,
              true,
            );

            if (valueDeclaration?.id !== topLevelDeclaration?.id) {
              outsideRef = true;
              break;
            }
          }

          if (!outsideRef) {
            diagnostics.push({
              range: this.getNodeRange(pattern),
              message: `Unused top level definition \`${pattern.text}\``,
              severity: DiagnosticSeverity.Warning,
              source: "ElmLS",
              tags: [DiagnosticTag.Unnecessary],
              data: { uri: tree.uri, code: "unused_top_level" },
            });
          }
        } else if (references.length === 0) {
          {
            diagnostics.push({
              range: this.getNodeRange(pattern),
              message: `Unused pattern variable \`${pattern.text}\``,
              severity: DiagnosticSeverity.Warning,
              source: "ElmLS",
              tags: [DiagnosticTag.Unnecessary],
              data: { uri: tree.uri, code: "unused_pattern" },
            });
          }
        }
      });

    return diagnostics;
  }

  private getCaseBranchMapNothingToNothingDiagnostics(
    tree: Tree,
  ): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const caseBranches = this.caseBranchesQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node);

    caseBranches.forEach((caseBranch) => {
      diagnostics.push({
        range: this.getNodeRange(caseBranch),
        message: `\`Nothing\` mapped to \`Nothing\` in case expression. Use Maybe.map or Maybe.andThen instead.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "map_nothing_to_nothing" },
      });
    });

    return diagnostics;
  }

  private getBooleanCaseExpressionDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    // For some reason, we can't match on case_expr, tree-sitter throws a memory access error
    const caseExpressions = this.booleanCaseExpressionsQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node.parent)
      .filter(Utils.notUndefinedOrNull.bind(this));

    caseExpressions.forEach((caseExpr) => {
      diagnostics.push({
        range: this.getNodeRange(caseExpr),
        message: `Use an if expression instead of a case expression.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "boolean_case_expr" },
      });
    });

    return diagnostics;
  }

  private getDropConcatOfListsDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const listExpressions = this.concatOfListsQuery
      .matches(tree.rootNode)
      .map((match) => [match.captures[0].node, match.captures[1].node])
      .filter(Utils.notUndefinedOrNull.bind(this));

    listExpressions.forEach(([startList, endList]) => {
      diagnostics.push({
        range: {
          start: this.getNodeRange(startList).start,
          end: this.getNodeRange(endList).end,
        },
        message: `If you concatenate two lists, then you can merge them into one list.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "drop_concat_of_lists" },
      });
    });

    return diagnostics;
  }

  private getDropConsOfItemAndListDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const consExpressions = this.consOfItemAndListQuery
      .matches(tree.rootNode)
      .map((match) => [match.captures[0].node, match.captures[1].node])
      .filter(Utils.notUndefinedOrNull.bind(this));

    consExpressions.forEach(([itemExpr, listExpr]) => {
      diagnostics.push({
        range: {
          start: this.getNodeRange(itemExpr).start,
          end: this.getNodeRange(listExpr).end,
        },
        message: `If you cons an item to a literal list, then you can just put the item into the list.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "drop_cons_of_item_and_list" },
      });
    });

    return diagnostics;
  }

  private getUseConsOverConcatDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const concatExpressions = this.useConsOverConcatQuery
      .matches(tree.rootNode)
      .map((match) => [match.captures[0].node, match.captures[1].node])
      .filter(Utils.notUndefinedOrNull.bind(this));

    concatExpressions.forEach(([firstPart, lastPart]) => {
      diagnostics.push({
        range: {
          start: this.getNodeRange(firstPart).start,
          end: this.getNodeRange(lastPart).end,
        },
        message: `If you concatenate two lists, but the first item is a single element list, then you should use the cons operator.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "use_cons_over_concat" },
      });
    });

    return diagnostics;
  }

  getSingleFieldRecordDiagnostics(
    tree: Tree,
    uri: string,
    program: IProgram,
  ): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const recordTypes = this.singleFieldRecordTypesQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node)
      .filter(Utils.notUndefinedOrNull.bind(this));

    recordTypes.forEach((recordType) => {
      let isSingleField = true;
      if (recordType.parent?.type === "type_ref" && recordType.parent.parent) {
        const type = program.getTypeChecker().findType(recordType.parent);

        const singleField = recordType.descendantsOfType(
          "lower_case_identifier",
        )[0];

        if (
          type.nodeType === "Record" &&
          Object.keys(type.fields).length > 1 &&
          type.fields[singleField.text]
        ) {
          isSingleField = false;
        }
      }

      if (isSingleField) {
        diagnostics.push({
          range: this.getNodeRange(recordType),
          message: `Using a record is obsolete if you only plan to store a single field in it.`,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          data: { uri: tree.uri, code: "single_field_record" },
        });
      }
    });

    return diagnostics;
  }

  private getUnnecessaryListConcatDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const listConcats = this.unnecessaryListConcatQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node)
      .filter(Utils.notUndefinedOrNull.bind(this));

    listConcats.forEach((listConcat) => {
      diagnostics.push({
        range: this.getNodeRange(listConcat),
        message: `You should just merge the arguments of \`List.concat\` to a single list.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "unnecessary_list_concat" },
      });
    });

    return diagnostics;
  }

  private getUnnecessaryPortModuleDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const unusedPortMatches = this.unusedPortModuleQuery.matches(tree.rootNode);

    if (
      unusedPortMatches[0]?.captures[0].name === "portModule" &&
      !unusedPortMatches[1]
    ) {
      diagnostics.push({
        range: this.getNodeRange(unusedPortMatches[0].captures[0].node),
        message: `Module is defined as a \`port\` module, but does not define any ports.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "unnecessary_port_module" },
      });
    }

    return diagnostics;
  }

  private getFullyAppliedOperatorAsPrefixDiagnostics(
    tree: Tree,
  ): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const operatorFunctions = this.operatorFunctionsQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node)
      .filter(Utils.notUndefinedOrNull.bind(this));

    operatorFunctions.forEach((operatorFunction) => {
      diagnostics.push({
        range: this.getNodeRange(operatorFunction),
        message: `Don't use fully applied prefix notation for operators.`,
        severity: DiagnosticSeverity.Warning,
        source: "ElmLS",
        data: { uri: tree.uri, code: "no_uncurried_prefix" },
      });
    });

    return diagnostics;
  }

  private getUnusedTypeAliasDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const typeAliases = this.typeAliasesQuery
      .matches(tree.rootNode)
      .map((match) => match.captures[0].node)
      .filter(Utils.notUndefinedOrNull.bind(this));

    const typeAliasUsages = this.typeAliasUsagesQuery
      .matches(tree.rootNode)
      .filter(Utils.notUndefined.bind(this));

    typeAliases.forEach((typeAlias) => {
      const references = typeAliasUsages.filter(
        (result) => result.captures[0].node.text === typeAlias.text,
      );
      if (references.length === 0 && typeAlias.parent) {
        diagnostics.push({
          range: this.getNodeRange(typeAlias.parent),
          message: `Type alias \`${typeAlias.text}\` is not used.`,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          tags: [DiagnosticTag.Unnecessary],
          data: { uri: tree.uri, code: "unused_type_alias" },
        });
      }
    });

    return diagnostics;
  }

  private getUnusedValueConstructorDiagnostics(tree: Tree): IDiagnostic[] {
    const diagnostics: IDiagnostic[] = [];

    const unionVariants = this.unionVariantsQuery
      .matches(tree.rootNode)
      .map((match) => [match.captures[1].node, match.captures[0].node])
      .filter(Utils.notUndefinedOrNull.bind(this));

    const unionVariantUsages = this.unionVariantUsagesQuery
      .matches(tree.rootNode)
      .filter(Utils.notUndefined.bind(this));

    unionVariants.forEach(([unionVariant, typeName]) => {
      const references = unionVariantUsages.filter(
        (result) =>
          result.captures[0].node.text ===
          (result.captures[0].name === "exposed.reference"
            ? `${typeName.text}(..)`
            : unionVariant.text),
      );

      if (references.length === 0 && unionVariant.parent) {
        diagnostics.push({
          range: this.getNodeRange(unionVariant.parent),
          message: `Value constructor \`${unionVariant.text}\` is not used.`,
          severity: DiagnosticSeverity.Warning,
          source: "ElmLS",
          tags: [DiagnosticTag.Unnecessary],
          data: { uri: tree.uri, code: "unused_value_constructor" },
        });
      }
    });

    return diagnostics;
  }

  private getNodeRange(node: SyntaxNode): Range {
    const end = PositionUtil.FROM_TS_POSITION(node.endPosition).toVSPosition();
    return {
      start: PositionUtil.FROM_TS_POSITION(node.startPosition).toVSPosition(),
      end: {
        ...end,
        character: end.character,
      },
    };
  }
}
