import { container } from "tsyringe";
import { Connection, ResponseError } from "vscode-languageserver";
import { SyntaxNode } from "web-tree-sitter";
import { ISourceFile } from "../compiler/forest";
import { Program } from "../compiler/program";
import { TypeChecker } from "../compiler/typeChecker";
import { Type } from "../compiler/typeInference";
import {
  EFunctionCallExpr,
  EValueExpr,
  EStringConstant,
  EListExpr,
  mapSyntaxNodeToExpression,
  Expression,
  ELetInExpr,
} from "../compiler/utils/expressionTree";
import {
  FindTestsRequest,
  IFindTestsParams,
  IFindTestsResponse,
  TestSuite,
} from "../protocol";
import { NoWorkspaceContainsError } from "../util/noWorkspaceContainsError";
import { TreeUtils } from "../util/treeUtils";
import { Utils } from "../util/utils";

export class FindTestsProvider {
  constructor() {
    this.register();
  }

  private register(): void {
    const connection = container.resolve<Connection>("Connection");
    connection.onRequest(FindTestsRequest, (params: IFindTestsParams) => {
      connection.console.info(
        `Finding tests is requested ${params.workspaceRoot.toString()}`,
      );
      try {
        const elmWorkspaces: Program[] = container.resolve("ElmWorkspaces");
        const program = elmWorkspaces.find(
          (program) =>
            program.getRootPath().toString() == params.workspaceRoot.toString(),
        );
        if (!program) {
          // TODO dedicated error?
          throw new NoWorkspaceContainsError(params.workspaceRoot);
        }
        const typeChecker = program.getTypeChecker();
        const suites: TestSuite[] = Array.from(
          program.getForest().treeMap.values(),
        )
          .filter((sourceFile) => sourceFile.isTestFile)
          .map((sourceFile) => {
            // connection.console.info(`Finding tests is in ${sourceFile.uri}`);
            const tests:
              | TestSuite[]
              | undefined = TreeUtils.findAllTopLevelFunctionDeclarations(
              sourceFile.tree,
            )
              ?.filter(Utils.notUndefinedOrNull)
              .map((top) =>
                findTestSuite(
                  findTestFunctionCall(top, typeChecker),
                  sourceFile,
                  typeChecker,
                ),
              )
              .filter(Utils.notUndefinedOrNull);
            const file = sourceFile.uri.toString();
            const label = sourceFile.moduleName;
            // connection.console.log(
            //   `Found ${tests?.length ?? 0} tests in module ${label ?? "?"}`,
            // );
            return label && tests && tests.length > 0
              ? <TestSuite>{
                  label,
                  file,
                  tests,
                  position: { line: 0, character: 0 },
                }
              : undefined;
          })
          .filter(Utils.notUndefinedOrNull);
        connection.console.info(
          `Found ${
            suites.length
          } top test suites in ${params.workspaceRoot.toString()}`,
        );
        return <IFindTestsResponse>{ suites };
      } catch (err) {
        connection.console.error(`Error finding tests`);
        // TODO improve error reporting
        return new ResponseError(13, "Error finding tests");
      }
    });
  }
}

// export for testing
export function findTestFunctionCall(
  node: SyntaxNode,
  typeChecker: TypeChecker,
): EFunctionCallExpr | undefined {
  const letIn = findChildExpr("LetInExpr", node);
  if (letIn) {
    return findTestFunctionCall(letIn.body, typeChecker);
  }
  const call = findExpr("FunctionCallExpr", node);
  if (!call) {
    return undefined;
  }
  const t: Type = typeChecker.findType(call);
  // TODO why are there two cases here?
  if (t.nodeType === "Function") {
    if (
      t.return.nodeType === "Union" &&
      t.return.module === "Test.Internal" &&
      t.return.name === "Test"
    ) {
      return call;
    }
  }
  if (
    t.nodeType === "Union" &&
    t.module === "Test.Internal" &&
    t.name === "Test"
  ) {
    return call;
  }
  // console.debug(
  //   "ignore non-test type",
  //   findExpr("ValueExpr", call.target)?.name,
  //   t,
  // );
  return undefined;
}

function isTestSuite(
  call: EFunctionCallExpr,
  sourceFile: ISourceFile,
  typeChecker: TypeChecker,
): boolean {
  const funName = findExpr("ValueExpr", call.target)?.name;
  const dot = funName?.lastIndexOf(".") ?? -1;
  const prefix = dot > -1 ? funName?.substring(0, dot) : undefined;
  const qualifier: string =
    prefix !== undefined
      ? typeChecker.getQualifierForName(sourceFile, prefix, "describe") ?? ""
      : "";
  const moduleName =
    prefix !== undefined
      ? typeChecker.findImportModuleNameNode(prefix, sourceFile)?.text
      : "Test";
  return (
    qualifier !== undefined &&
    funName === `${qualifier}describe` &&
    moduleName === "Test"
  );
}

function findFirstStringArg(
  call: EFunctionCallExpr,
  typeChecker: TypeChecker,
): Expression | undefined {
  const stringArg = call.args.find((arg) => {
    const t: Type = typeChecker.findType(arg);
    return typeChecker.typeToString(t) === "String";
  });
  return stringArg;
}

// export for testing
export function findTestSuite(
  call: EFunctionCallExpr | undefined,
  sourceFile: ISourceFile,
  typeChecker: TypeChecker,
): TestSuite | undefined {
  if (!call) {
    return undefined;
  }

  const stringArg = findFirstStringArg(call, typeChecker);
  const labelParts = findAllExprs("StringConstant", stringArg)
    ?.map((e) => e.text)
    .map((l) => stringLiteralToLabel(l));
  const position: TestSuite["position"] = {
    line: call.startPosition.row,
    character: call.startPosition.column,
  };
  // TODO relative to workspace?
  const file = sourceFile.uri.toString();
  const label = labelParts?.length === 1 ? labelParts[0] : labelParts;
  if (label && isTestSuite(call, sourceFile, typeChecker)) {
    const testExprs = findExpr("ListExpr", call.args[1])?.exprList;
    const tests: TestSuite[] | undefined = testExprs
      ?.map((e) => findTestFunctionCall(e, typeChecker))
      .map((call) => findTestSuite(call, sourceFile, typeChecker))
      .filter(Utils.notUndefinedOrNull);
    return tests && <TestSuite>{ label, tests, file, position };
  }
  return label ? <TestSuite>{ label, file, position } : undefined;
}

type ExpressionNodeTypes = {
  ValueExpr: EValueExpr;
  StringConstant: EStringConstant;
  ListExpr: EListExpr;
  FunctionCallExpr: EFunctionCallExpr;
  LetInExpr: ELetInExpr;
};

type TypeExpressionNodeTypes = {
  value_expr: EValueExpr;
  string_constant_expr: EStringConstant;
  list_expr: EListExpr;
  function_call_expr: EFunctionCallExpr;
  let_in_expr: ELetInExpr;
};

const typeByNodeType: Map<
  keyof ExpressionNodeTypes,
  keyof TypeExpressionNodeTypes
> = new Map([
  ["ValueExpr", "value_expr"],
  ["StringConstant", "string_constant_expr"],
  ["ListExpr", "list_expr"],
  ["FunctionCallExpr", "function_call_expr"],
  ["LetInExpr", "let_in_expr"],
]);

function findExpr<K extends keyof ExpressionNodeTypes>(
  key: K,
  node: SyntaxNode | undefined,
): ExpressionNodeTypes[K] | undefined {
  if (!node) {
    return undefined;
  }
  const type = typeByNodeType.get(key);
  if (!type) {
    return undefined;
  }
  const n =
    node.type === type ? node : TreeUtils.descendantsOfType(node, type)[0];
  const e = mapSyntaxNodeToExpression(n);
  return e && mapExpr(key, e);
}

function findChildExpr<K extends keyof ExpressionNodeTypes>(
  key: K,
  node: SyntaxNode | undefined,
): ExpressionNodeTypes[K] | undefined {
  if (!node) {
    return undefined;
  }
  const type = typeByNodeType.get(key);
  if (!type) {
    return undefined;
  }
  const n =
    node.type === type ? node : TreeUtils.findFirstNamedChildOfType(type, node);
  const e = mapSyntaxNodeToExpression(n);
  return e && mapExpr(key, e);
}

function findAllExprs<K extends keyof ExpressionNodeTypes>(
  key: K,
  node: SyntaxNode | undefined,
): ExpressionNodeTypes[K][] | undefined {
  if (!node) {
    return undefined;
  }
  const type = typeByNodeType.get(key);
  if (!type) {
    return undefined;
  }
  const children = TreeUtils.descendantsOfType(node, type);
  const es = children?.map((n) => mapSyntaxNodeToExpression(n));
  return es?.map((e) => e && mapExpr(key, e)).flatMap((v) => (v ? [v] : []));
}

function mapExpr<K extends keyof ExpressionNodeTypes>(
  k: K,
  e: Expression,
): ExpressionNodeTypes[K] | undefined {
  return e?.nodeType === k ? (e as ExpressionNodeTypes[K]) : undefined;
}

function stringLiteralToLabel(literal: string): string {
  return String(JSON.parse(literal));
}
