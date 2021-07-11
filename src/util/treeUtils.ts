import { Position } from "vscode-languageserver";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { ISourceFile } from "../compiler/forest";
import { comparePosition } from "../positionUtil";
import { TRecord, Type } from "../compiler/typeInference";
import { IProgram } from "../compiler/program";
import {
  EFunctionCallExpr,
  mapSyntaxNodeToExpression,
} from "../compiler/utils/expressionTree";
import { Range } from "vscode-languageserver-textdocument";
import { ISymbol } from "../compiler/binder";

export type NodeType =
  | "Function"
  | "FunctionParameter"
  | "TypeAlias"
  | "Type"
  | "Operator"
  | "Module"
  | "CasePattern"
  | "AnonymousFunctionParameter"
  | "UnionConstructor"
  | "FieldType"
  | "TypeVariable"
  | "Port"
  | "Import";

const functionNameRegex = new RegExp("[a-zA-Z0-9_]+");

export class TreeUtils {
  public static getModuleNameNode(tree: Tree): SyntaxNode | undefined {
    const moduleDeclaration: SyntaxNode | undefined =
      this.findModuleDeclaration(tree);
    return moduleDeclaration?.childForFieldName("name") ?? undefined;
  }

  public static getModuleExposingListNodes(tree: Tree): SyntaxNode[] {
    const moduleNode = TreeUtils.findModuleDeclaration(tree);

    if (moduleNode) {
      return [
        ...moduleNode.descendantsOfType(["exposed_value", "exposed_type"]),
      ];
    }

    return [];
  }

  public static findFirstNamedChildOfType(
    type: string,
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    return node.children.find((child) => child.type === type);
  }

  public static findAllNamedChildrenOfType(
    type: string | string[],
    node: SyntaxNode,
  ): SyntaxNode[] | undefined {
    const result = Array.isArray(type)
      ? node.children.filter((child) => type.includes(child.type))
      : node.children.filter((child) => child.type === type);

    return result.length === 0 ? undefined : result;
  }

  public static findExposedFunctionNode(
    node: SyntaxNode,
    functionName: string,
  ): SyntaxNode | undefined {
    if (node) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        node,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return undefined;
        }
      }
      const descendants = TreeUtils.descendantsOfType(node, "exposed_value");
      return descendants.find((desc) => desc.text === functionName);
    }
  }

  public static isExposedFunctionOrPort(
    tree: Tree,
    functionName: string,
  ): boolean {
    const module = this.findModuleDeclaration(tree);
    if (module) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        module,
      );
      if (exposingList) {
        const doubleDot = exposingList.childForFieldName("doubleDot");
        if (doubleDot) {
          return true;
        }
      }
      const descendants = TreeUtils.descendantsOfType(module, "exposed_value");
      return descendants.some((desc) => desc.text === functionName);
    }
    return false;
  }

  public static findExposedTypeOrTypeAliasNode(
    node: SyntaxNode,
    typeName: string,
  ): SyntaxNode | undefined {
    if (node) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        node,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return undefined;
        }
      }
      const descendants = TreeUtils.descendantsOfType(node, "exposed_type");
      const match = descendants.find((desc) => desc.text.startsWith(typeName));
      if (match && match.firstNamedChild) {
        return match.firstNamedChild;
      }
    }
    return undefined;
  }

  public static isExposedTypeOrTypeAlias(
    tree: Tree,
    typeName: string,
  ): boolean {
    const module = this.findModuleDeclaration(tree);
    if (module) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        module,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return true;
        }
      }
      const descendants = TreeUtils.descendantsOfType(module, "exposed_type");
      return descendants.some((desc) => desc.text.startsWith(typeName));
    }
    return false;
  }

  public static findUnionConstructor(
    tree: Tree,
    unionConstructorName: string,
  ): SyntaxNode | undefined {
    const unionVariants = TreeUtils.descendantsOfType(
      tree.rootNode,
      "union_variant",
    );
    if (unionVariants.length > 0) {
      return unionVariants.find(
        (a) =>
          a.firstChild !== null &&
          a.firstChild.type === "upper_case_identifier" &&
          a.firstChild.text === unionConstructorName,
      );
    }
  }

  public static findUnionConstructorCalls(
    tree: Tree,
    unionConstructorName: string,
    moduleNamePrefix?: string,
  ): SyntaxNode[] | undefined {
    const upperCaseQid = TreeUtils.descendantsOfType(
      tree.rootNode,
      "upper_case_qid",
    );
    if (upperCaseQid.length > 0) {
      const result = upperCaseQid.filter(
        (a) =>
          (a.text === unionConstructorName ||
            (moduleNamePrefix &&
              a.text === `${moduleNamePrefix}.${unionConstructorName}`)) &&
          a.parent &&
          a.parent.type !== "type_ref" &&
          a.parent.type !== "import_clause",
      );
      return result.length === 0 ? undefined : result;
    }
  }

  public static findFunction(
    syntaxNode: SyntaxNode,
    functionName: string,
    onlySearchTopLevel = true,
  ): SyntaxNode | undefined {
    const functions = onlySearchTopLevel
      ? syntaxNode.children.filter((a) => a.type === "value_declaration")
      : syntaxNode.descendantsOfType("value_declaration");

    let ret;
    if (functions) {
      ret = functions
        .map((elmFunction) =>
          TreeUtils.findFirstNamedChildOfType(
            "function_declaration_left",
            elmFunction,
          ),
        )
        .find((declaration) => {
          if (declaration && declaration.firstNamedChild) {
            return functionName === declaration.firstNamedChild.text;
          }
        });

      if (!ret) {
        for (const elmFunction of functions) {
          const pattern = TreeUtils.findFirstNamedChildOfType(
            "pattern",
            elmFunction,
          );
          if (pattern) {
            ret =
              pattern
                .descendantsOfType("lower_pattern")
                .find((a) => functionName === a.text) ?? undefined;

            if (ret) {
              break;
            }
          }
        }
      }
      return ret;
    }
  }

  public static findPort(tree: Tree, portName: string): SyntaxNode | undefined {
    return TreeUtils.findAllNamedChildrenOfType(
      "port_annotation",
      tree.rootNode,
    )?.find(
      (node) =>
        node.children.length > 1 &&
        node.children[1].type === "lower_case_identifier" &&
        node.children[1].text === portName,
    );
  }

  public static findOperator(
    sourceFile: ISourceFile,
    operatorName: string,
  ): SyntaxNode | undefined {
    const rootSymbols = sourceFile.symbolLinks?.get(sourceFile.tree.rootNode);

    const operatorNode = rootSymbols?.get(operatorName)?.node;

    if (operatorNode) {
      const functionReference = TreeUtils.findFirstNamedChildOfType(
        "value_expr",
        operatorNode,
      );
      if (functionReference) {
        return rootSymbols?.get(
          functionReference.text,
          (s) => s.node.type !== "infix_declaration",
        )?.node;
      }
    }
  }

  public static findTypeDeclaration(
    tree: Tree,
    typeName: string,
  ): SyntaxNode | undefined {
    const types = this.findAllTypeDeclarations(tree);
    if (types) {
      return types.find(
        (a) =>
          a.children.length > 1 &&
          a.children[1].type === "upper_case_identifier" &&
          a.children[1].text === typeName,
      );
    }
  }

  public static findModuleDeclaration(tree: Tree): SyntaxNode | undefined {
    return tree.rootNode.childForFieldName("moduleDeclaration") ?? undefined;
  }

  public static findTypeAliasDeclaration(
    tree: Tree,
    typeAliasName: string,
  ): SyntaxNode | undefined {
    const typeAliases = this.findAllTypeAliasDeclarations(tree);
    if (typeAliases) {
      return typeAliases.find(
        (a) =>
          a.children.length > 2 &&
          a.children[2].type === "upper_case_identifier" &&
          a.children[2].text === typeAliasName,
      );
    }
  }

  public static findAllTopLevelFunctionDeclarations(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) => a.type === "value_declaration",
    );
    return result.length === 0 ? undefined : result;
  }

  public static findAllTopLevelFunctionDeclarationsWithoutTypeAnnotation(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) =>
        a.type === "value_declaration" &&
        a.previousNamedSibling?.type !== "type_annotation",
    );
    return result.length === 0 ? undefined : result;
  }

  public static findAllTypeOrTypeAliasCalls(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result: SyntaxNode[] = [];
    const typeRefs = TreeUtils.descendantsOfType(tree.rootNode, "type_ref");
    if (typeRefs.length > 0) {
      typeRefs.forEach((a) => {
        if (
          a.firstChild &&
          a.firstChild.type === "upper_case_qid" &&
          a.firstChild.firstChild
        ) {
          result.push(a.firstChild);
        }
      });
    }

    return result.length === 0 ? undefined : result;
  }

  public static getFunctionNameNodeFromDefinition(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    if (node.type === "lower_case_identifier") {
      return node;
    }
    const declaration =
      node.type == "function_declaration_left"
        ? node
        : node.childForFieldName("functionDeclarationLeft");
    if (declaration && declaration.firstNamedChild) {
      return declaration.firstNamedChild;
    }
  }

  public static getTypeOrTypeAliasOrPortNameNodeFromDefinition(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    return node.childForFieldName("name") ?? undefined;
  }

  public static findTypeOrTypeAliasCalls(
    tree: Tree,
    typeOrTypeAliasName: string,
  ): SyntaxNode[] | undefined {
    const typeOrTypeAliasNodes = this.findAllTypeOrTypeAliasCalls(tree);
    if (typeOrTypeAliasNodes) {
      const result: SyntaxNode[] = typeOrTypeAliasNodes.filter((a) => {
        return a.text === typeOrTypeAliasName;
      });

      return result.length === 0 ? undefined : result;
    }
  }

  public static findAllTypeDeclarations(tree: Tree): SyntaxNode[] | undefined {
    return this.findAllNamedChildrenOfType("type_declaration", tree.rootNode);
  }

  public static findAllTypeAliasDeclarations(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    return this.findAllNamedChildrenOfType(
      "type_alias_declaration",
      tree.rootNode,
    );
  }

  public static findTypeAliasTypeVariable(
    nodeAtPosition: SyntaxNode,
    nodeAtPositionText: string,
  ): SyntaxNode | undefined {
    const parentTypeAlias = this.findParentOfType(
      "type_alias_declaration",
      nodeAtPosition,
    );

    if (parentTypeAlias) {
      const lowerTypeNames = TreeUtils.findAllNamedChildrenOfType(
        "lower_type_name",
        parentTypeAlias,
      );

      return lowerTypeNames?.find((t) => t.text === nodeAtPositionText);
    }
  }

  /**
   * @deprecated Should not be used due to performance. Use bindings instead
   */
  public static findImportClauseByName(
    tree: Tree,
    moduleName: string,
  ): SyntaxNode | undefined {
    const allImports = this.findAllImportClauseNodes(tree);
    if (allImports) {
      return allImports.find(
        (a) =>
          a.children.length > 1 &&
          a.children[1].type === "upper_case_qid" &&
          a.children[1].text === moduleName,
      );
    }
  }

  public static getTypeOrTypeAliasOfFunctionParameter(
    node: SyntaxNode | undefined,
  ): SyntaxNode | undefined {
    if (
      node &&
      node.parent &&
      node.parent.parent &&
      node.parent.parent.parent &&
      node.parent.parent.parent.previousNamedSibling &&
      node.parent.parent.parent.previousNamedSibling.type ===
        "type_annotation" &&
      node.parent.parent.parent.previousNamedSibling.lastNamedChild
    ) {
      const functionParameterNodes = TreeUtils.findAllNamedChildrenOfType(
        ["pattern", "lower_pattern"],
        node.parent.parent,
      );
      if (functionParameterNodes) {
        const matchIndex = functionParameterNodes.findIndex(
          (a) => a.text === node.text,
        );

        const typeAnnotationNodes = TreeUtils.findAllNamedChildrenOfType(
          ["type_ref", "type_expression"],
          node.parent.parent.parent.previousNamedSibling.lastNamedChild,
        );
        if (typeAnnotationNodes) {
          return typeAnnotationNodes[matchIndex];
        }
      }
    }
  }

  public static getReturnTypeOrTypeAliasOfFunctionDefinition(
    node: SyntaxNode | undefined,
  ): SyntaxNode | undefined {
    if (node && node.previousNamedSibling?.type === "type_annotation") {
      const typeAnnotationNodes = TreeUtils.descendantsOfType(
        node.previousNamedSibling,
        "type_ref",
      );
      if (typeAnnotationNodes) {
        const type = typeAnnotationNodes[typeAnnotationNodes.length - 1];
        return type.firstNamedChild?.firstNamedChild ?? type;
      }
    }
  }

  public static getRecordTypeOfFunctionRecordParameter(
    node: SyntaxNode | undefined,
    program: IProgram,
  ): TRecord | undefined {
    const checker = program.getTypeChecker();
    if (
      node?.parent?.type === "function_call_expr" &&
      node.parent.firstNamedChild
    ) {
      const functionCallExpr = mapSyntaxNodeToExpression(
        node.parent,
      ) as EFunctionCallExpr;

      const parameterIndex =
        functionCallExpr.namedChildren.map((c) => c.text).indexOf(node.text) -
        1;

      const foundType = checker.findType(functionCallExpr.target);

      if (foundType.nodeType === "Function") {
        const paramType = foundType.params[parameterIndex];

        if (paramType.nodeType === "Record") {
          return paramType;
        }
      }
    }
  }

  public static getTypeAliasOfRecordField(
    node: SyntaxNode | undefined,
    sourceFile: ISourceFile,
    program: IProgram,
  ): SyntaxNode | undefined {
    const fieldName = node?.parent?.firstNamedChild?.text;

    let recordType = TreeUtils.getTypeAliasOfRecord(node, sourceFile, program);

    while (!recordType && node?.parent?.parent) {
      node = node.parent.parent;
      recordType = TreeUtils.getTypeAliasOfRecordField(
        node,
        sourceFile,
        program,
      );
    }

    const recordTypeTree = program
      .getForest()
      .getByUri(recordType?.tree.uri ?? "");

    if (recordType && recordTypeTree) {
      const fieldTypes = TreeUtils.descendantsOfType(recordType, "field_type");
      const fieldNode = fieldTypes.find((a) => {
        return (
          TreeUtils.findFirstNamedChildOfType("lower_case_identifier", a)
            ?.text === fieldName
        );
      });

      if (fieldNode) {
        const typeExpression = TreeUtils.findFirstNamedChildOfType(
          "type_expression",
          fieldNode,
        );

        if (typeExpression) {
          const typeNode = TreeUtils.descendantsOfType(
            typeExpression,
            "upper_case_identifier",
          );

          if (typeNode.length > 0) {
            const typeAliasNode = program
              .getTypeChecker()
              .findDefinition(typeNode[0], recordTypeTree).symbol;

            if (typeAliasNode) {
              return typeAliasNode.node;
            }
          }
        }
      }
    }
  }

  public static getTypeAliasOfCase(
    type: SyntaxNode | undefined,
    sourceFile: ISourceFile,
    program: IProgram,
  ): SyntaxNode | undefined {
    if (type) {
      const definitionNode = program
        .getTypeChecker()
        .findDefinition(type, sourceFile).symbol;

      if (definitionNode) {
        const definitionTree = program
          .getForest()
          .getByUri(definitionNode.node.tree.uri);

        let aliasNode;
        if (definitionNode.type === "FunctionParameter") {
          aliasNode = TreeUtils.getTypeOrTypeAliasOfFunctionParameter(
            definitionNode.node,
          );
        } else if (definitionNode.type === "Function") {
          aliasNode = TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
            definitionNode.node,
          );
        } else if (definitionNode.type === "FieldType") {
          aliasNode = TreeUtils.findFirstNamedChildOfType(
            "type_expression",
            definitionNode.node,
          );
        } else if (definitionNode.type === "TypeAlias") {
          return definitionNode.node;
        }

        if (aliasNode && definitionTree) {
          const childNode = TreeUtils.descendantsOfType(
            aliasNode,
            "upper_case_identifier",
          );

          if (childNode.length > 0) {
            const typeNode = program
              .getTypeChecker()
              .findDefinition(childNode[0], definitionTree).symbol;

            if (typeNode) {
              return typeNode.node;
            }
          }
        }
      }
    }
  }

  public static getTypeAliasOfRecord(
    node: SyntaxNode | undefined,
    sourceFile: ISourceFile,
    program: IProgram,
  ): SyntaxNode | undefined {
    if (node?.parent?.parent) {
      let type: SyntaxNode | undefined | null =
        TreeUtils.findFirstNamedChildOfType(
          "record_base_identifier",
          node.parent.parent,
        ) ??
        TreeUtils.findFirstNamedChildOfType(
          "record_base_identifier",
          node.parent,
        );

      // Handle records of function returns
      if (!type && node.parent.parent.parent) {
        type =
          TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
            node.parent.parent.parent,
          )?.parent ?? undefined;
      }

      if (!type) {
        type = node;
      }

      if (type) {
        const definitionNode = program
          .getTypeChecker()
          .findDefinition(
            type.firstNamedChild ? type.firstNamedChild : type,
            sourceFile,
          ).symbol;

        if (definitionNode) {
          const definitionTree = program
            .getForest()
            .getByUri(definitionNode.node.tree.uri);

          let aliasNode;
          if (
            definitionNode.type === "FunctionParameter" &&
            definitionNode.node.firstNamedChild
          ) {
            aliasNode = TreeUtils.getTypeOrTypeAliasOfFunctionParameter(
              definitionNode.node.firstNamedChild,
            );
          } else if (definitionNode.type === "Function") {
            aliasNode = TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
              definitionNode.node,
            );
          } else if (definitionNode.type === "FieldType") {
            aliasNode = TreeUtils.findFirstNamedChildOfType(
              "type_expression",
              definitionNode.node,
            );
          } else if (definitionNode.type === "TypeAlias") {
            return definitionNode.node;
          }

          if (aliasNode && definitionTree) {
            const childNode = TreeUtils.descendantsOfType(
              aliasNode,
              "upper_case_identifier",
            );

            if (childNode.length > 0) {
              const typeNode = program
                .getTypeChecker()
                .findDefinition(childNode[0], definitionTree).symbol;

              if (typeNode) {
                return typeNode.node;
              }
            }
          }
        }
      }
    }
  }

  public static getAllFieldsFromTypeAlias(
    node: SyntaxNode | undefined,
  ): { field: string; type: string }[] | undefined {
    const result: { field: string; type: string }[] = [];
    if (node) {
      const fieldTypes = TreeUtils.descendantsOfType(node, "field_type");
      if (fieldTypes.length > 0) {
        fieldTypes.forEach((a) => {
          const fieldName = TreeUtils.findFirstNamedChildOfType(
            "lower_case_identifier",
            a,
          );
          const typeExpression = TreeUtils.findFirstNamedChildOfType(
            "type_expression",
            a,
          );
          if (fieldName && typeExpression) {
            result.push({ field: fieldName.text, type: typeExpression.text });
          }
        });
      }
    }
    return result.length === 0 ? undefined : result;
  }

  public static descendantsOfType(
    node: SyntaxNode,
    type: string,
  ): SyntaxNode[] {
    return node.descendantsOfType(type);
  }

  public static getNamedDescendantForPosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const previousCharColumn =
      position.character === 0 ? 0 : position.character - 1;
    const charBeforeCursor = node.text
      .split("\n")
      [position.line].substring(previousCharColumn, position.character);

    if (!functionNameRegex.test(charBeforeCursor)) {
      return node.namedDescendantForPosition({
        column: position.character,
        row: position.line,
      });
    } else {
      return node.namedDescendantForPosition(
        {
          column: previousCharColumn,
          row: position.line,
        },
        {
          column: position.character,
          row: position.line,
        },
      );
    }
  }

  public static getNamedDescendantForRange(
    sourceFile: ISourceFile,
    range: Range,
  ): SyntaxNode {
    return sourceFile.tree.rootNode.namedDescendantForPosition(
      {
        column: range.start.character,
        row: range.start.line,
      },
      {
        column: range.end.character,
        row: range.end.line,
      },
    );
  }

  public static findPreviousNode(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode | undefined {
    function nodeHasTokens(n: SyntaxNode): boolean {
      return n.endIndex - n.startIndex !== 0;
    }

    function findRightmostChildWithTokens(
      childrenList: SyntaxNode[],
      startIndex: number,
    ): SyntaxNode | undefined {
      for (let i = startIndex - 1; i >= 0; i--) {
        if (nodeHasTokens(childrenList[i])) {
          return childrenList[i];
        }
      }
    }

    function findRightmostNode(n: SyntaxNode): SyntaxNode | undefined {
      if (n.children.length === 0) {
        return n;
      }

      const candidate = findRightmostChildWithTokens(
        n.children,
        n.children.length,
      );

      if (candidate) {
        return findRightmostNode(candidate);
      }
    }

    const children = node.children;

    if (children.length === 0) {
      return node;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (comparePosition(position, child.endPosition) < 0) {
        const lookInPreviousChild =
          comparePosition(position, child.startPosition) <= 0 ||
          !nodeHasTokens(child);

        if (lookInPreviousChild) {
          const candidate = findRightmostChildWithTokens(children, i);
          if (candidate) {
            return findRightmostNode(candidate);
          }
        } else {
          return this.findPreviousNode(child, position);
        }
      }
    }

    const candidate = findRightmostChildWithTokens(children, children.length);
    if (candidate) {
      return findRightmostNode(candidate);
    }
  }

  public static getNamedDescendantForLineBeforePosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const previousLine = position.line === 0 ? 0 : position.line - 1;

    return node.namedDescendantForPosition({
      column: 0,
      row: previousLine,
    });
  }

  public static getNamedDescendantForLineAfterPosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const followingLine = position.line + 1;

    return node.namedDescendantForPosition({
      column: 0,
      row: followingLine,
    });
  }

  public static findParentOfType(
    typeToLookFor: string,
    node: SyntaxNode,
    topLevel = false,
  ): SyntaxNode | undefined {
    if (
      node.type === typeToLookFor &&
      (!topLevel || node.parent?.type === "file")
    ) {
      return node;
    }
    if (node.parent) {
      return this.findParentOfType(typeToLookFor, node.parent, topLevel);
    }
  }

  public static getLastImportNode(tree: Tree): SyntaxNode | undefined {
    const allImportNodes = this.findAllImportClauseNodes(tree);
    if (allImportNodes?.length) {
      return allImportNodes[allImportNodes.length - 1];
    }
  }

  public static isReferenceFullyQualified(node: SyntaxNode): boolean {
    return (
      node.previousNamedSibling?.type === "dot" &&
      node.previousNamedSibling?.previousNamedSibling?.type ===
        "upper_case_identifier"
    );
  }

  public static getTypeAnnotation(
    valueDeclaration?: SyntaxNode,
  ): SyntaxNode | undefined {
    if (valueDeclaration?.type !== "value_declaration") {
      return;
    }

    let candidate = valueDeclaration.previousNamedSibling;

    // Skip comments
    while (
      candidate?.type === "line_comment" ||
      candidate?.type === "comment_block"
    ) {
      candidate = candidate.previousNamedSibling;
    }

    if (candidate?.type === "type_annotation") {
      return candidate;
    }
  }

  public static getValueDeclaration(
    typeAnnotation?: SyntaxNode,
  ): SyntaxNode | undefined {
    if (typeAnnotation?.type !== "type_annotation") {
      return;
    }

    let candidate = typeAnnotation.nextNamedSibling;

    // Skip comments
    while (
      candidate?.type === "line_comment" ||
      candidate?.type === "comment_block"
    ) {
      candidate = candidate.nextNamedSibling;
    }

    if (candidate?.type === "value_declaration") {
      return candidate;
    }
  }

  /**
   * This gets a list of all ancestors of a type
   * in order from the closest declaration up to the top level declaration
   */
  public static getAllAncestorsOfType(
    type: string,
    node: SyntaxNode,
  ): SyntaxNode[] {
    const declarations = [];

    while (node.type !== "file") {
      if (node.type === type) {
        declarations.push(node);
      }

      if (node.parent) {
        node = node.parent;
      } else {
        break;
      }
    }

    return declarations;
  }

  /**
   * @deprecated Should not be used due to performance. Use bindings instead
   */
  public static findAllImportClauseNodes(tree: Tree): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) => a.type === "import_clause",
    );

    return result.length === 0 ? undefined : result;
  }

  public static isIdentifier(node: SyntaxNode): boolean {
    return (
      node.type === "lower_case_identifier" ||
      node.type === "upper_case_identifier"
    );
  }

  public static isImport(node: SyntaxNode): boolean {
    return (
      node.parent?.firstNamedChild?.type === "import" ||
      node.parent?.parent?.firstNamedChild?.type === "import"
    );
  }

  public static nextNode(node: SyntaxNode): SyntaxNode | undefined {
    // Move up until we have a sibling
    while (!node.nextNamedSibling && node.parent) {
      node = node.parent;
    }

    if (node.nextNamedSibling) {
      node = node.nextNamedSibling;

      // Move down the leftmost subtree
      while (node.firstNamedChild) {
        node = node.firstNamedChild;
      }

      return node;
    }
  }

  public static findFieldReference(
    type: Type,
    fieldName: string,
  ): ISymbol | undefined {
    if (type.nodeType === "Record") {
      const fieldRefs = type.fieldReferences.get(fieldName);

      if (fieldRefs.length > 0) {
        return { name: fieldName, node: fieldRefs[0], type: "FieldType" };
      }
    }
  }

  public static findImportAliasOfModule(
    moduleName: string,
    tree: Tree,
  ): string | undefined {
    const importClause = TreeUtils.findImportClauseByName(tree, moduleName);

    const asClause = importClause?.childForFieldName("asClause");

    if (asClause) {
      return asClause.childForFieldName("name")?.text;
    } else {
      return importClause?.childForFieldName("moduleName")?.text;
    }
  }
}
