/* eslint-disable @typescript-eslint/naming-convention */
import { SyntaxNode } from "web-tree-sitter";
import { TreeUtils } from "../util/treeUtils";
import { References } from "./references";
import {
  BinaryExprTree,
  IOperatorPrecedence,
  Operand,
  Binary,
} from "./operatorPrecedence";
import { DisjointSet } from "./utils/disjointSet";
import { TypeReplacement } from "./typeReplacement";
import {
  Expression,
  EValueDeclaration,
  EFunctionCallExpr,
  EBinOpExpr,
  EOperator,
  EFunctionDeclarationLeft,
  EPattern,
  mapSyntaxNodeToExpression,
  findDefinition,
  EIfElseExpr,
  ELetInExpr,
  ECaseOfExpr,
  EAnonymousFunctionExpr,
  ETuplePattern,
  EListExpr,
  EUnionPattern,
  EListPattern,
  EConsPattern,
  ERecordPattern,
  EFieldAccessorFunctionExpr,
  EOperatorAsFunctionExpr,
  ERecordExpr,
  EFieldAccessExpr,
  ENegateExpr,
  ETypeAnnotation,
} from "./utils/expressionTree";
import { SyntaxNodeMap } from "./utils/syntaxNodeMap";
import { TypeExpression } from "./typeExpression";
import { IProgram } from "./program";
import { Sequence } from "../util/sequence";
import { Utils } from "../util/utils";
import { RecordFieldReferenceTable } from "./utils/recordFieldReferenceTable";
import { TypeChecker } from "./typeChecker";
import { performance } from "perf_hooks";
import { ICancellationToken } from "../cancellation";
import {
  Diagnostic,
  Diagnostics,
  error,
  errorWithEndNode,
} from "./diagnostics";
import { isKernelProject, nameIsKernel } from "./utils/elmUtils";
import { PatternMatches } from "./patternMatches";

export let inferTime = 0;
export function resetInferTime(): void {
  inferTime = 0;
}

export interface Alias {
  module: string;
  name: string;
  parameters: Type[];
}

export type Type =
  | TVar
  | TFunction
  | TTuple
  | TUnion
  | TUnit
  | TInProgressBinding
  | TUnknown
  | TRecord
  | TMutableRecord;

export interface TVar {
  nodeType: "Var";
  name: string;
  rigid?: boolean;
  alias?: Alias;
}
export interface TFunction {
  nodeType: "Function";
  params: Type[];
  return: Type;
  alias?: Alias;
}
export interface TTuple {
  nodeType: "Tuple";
  types: Type[];
  alias?: Alias;
}
export interface TUnion {
  nodeType: "Union";
  module: string;
  name: string;
  params: Type[];
  alias?: Alias;
}
export interface TRecord {
  nodeType: "Record";
  fields: { [key: string]: Type };
  baseType?: Type;
  alias?: Alias;
  fieldReferences: RecordFieldReferenceTable;
}
export interface TMutableRecord {
  nodeType: "MutableRecord";
  fields: { [key: string]: Type };
  baseType?: Type;
  alias?: Alias;
  fieldReferences: RecordFieldReferenceTable;
}
interface TUnit {
  nodeType: "Unit";
  alias?: Alias;
}
interface TInProgressBinding {
  nodeType: "InProgressBinding";
  alias?: Alias;
}
interface TUnknown {
  nodeType: "Unknown";
  alias?: Alias;
}

export const TUnion = (
  module: string,
  name: string,
  params: Type[],
  alias?: Alias,
): TUnion => {
  return { nodeType: "Union", module, name, params, alias };
};

export const TVar = (name: string, rigid = false): TVar => {
  return { nodeType: "Var", name, rigid };
};

export const TFunction = (
  params: Type[],
  ret: Type,
  alias?: Alias,
): TFunction => {
  return { nodeType: "Function", params, return: ret, alias };
};

export const TTuple = (types: Type[], alias?: Alias): TTuple => {
  if (types.length === 0) {
    throw new Error("Cannot create a TTuple with no types, use TUnit");
  }

  return { nodeType: "Tuple", types, alias };
};

export const TRecord = (
  fields: { [key: string]: Type },
  baseType?: Type,
  alias?: Alias,
  fieldReferences = new RecordFieldReferenceTable(),
): TRecord => {
  return {
    nodeType: "Record",
    fields,
    baseType,
    alias,
    fieldReferences,
  };
};

export const TMutableRecord = (
  fields: { [key: string]: Type },
  baseType?: Type,
  fieldReferences = new RecordFieldReferenceTable(),
): TMutableRecord => {
  return {
    nodeType: "MutableRecord",
    fields,
    baseType,
    fieldReferences,
  };
};

function mutableRecordAsRecord(mutableRecord: TMutableRecord): TRecord {
  return {
    nodeType: "Record",
    fields: mutableRecord.fields,
    baseType: mutableRecord.baseType,
    fieldReferences: mutableRecord.fieldReferences,
  };
}

export const TUnknown: TUnknown = {
  nodeType: "Unknown",
};

const TInt = (): TUnion => TUnion("Basics", "Int", []);
const TFloat = (): TUnion => TUnion("Basics", "Float", []);
const TBool = (): TUnion => TUnion("Basics", "Bool", []);
const TString = (): TUnion => TUnion("String", "String", []);
const TChar = (): TUnion => TUnion("Char", "Char", []);
const TShader = (): TUnion =>
  TUnion("WebGL", "Shader", [TUnknown, TUnknown, TUnknown]);

export const TList = (elementType: Type): TUnion =>
  TUnion("List", "List", [elementType]);

const TNumber = (): TVar => TVar("number");

export const TUnit: TUnit = {
  nodeType: "Unit",
};

export const TInProgressBinding: TInProgressBinding = {
  nodeType: "InProgressBinding",
};

const typeIsList = (t: TUnion): boolean =>
  t.module === "List" && t.name === "List";
const typeIsInt = (t: TUnion): boolean =>
  t.module === TInt().module && t.name === TInt().name;
const typeIsFloat = (t: TUnion): boolean =>
  t.module === TFloat().module && t.name === TFloat().name;
const typeIsBool = (t: TUnion): boolean =>
  t.module === TBool().module && t.name === TBool().name;
const typeIsString = (t: TUnion): boolean =>
  t.module === TString().module && t.name === TString().name;
const typeIsChar = (t: TUnion): boolean =>
  t.module === TChar().module && t.name === TChar().name;

function allTypeVars(type: Type): TVar[] {
  switch (type.nodeType) {
    case "Var":
      return [type];
    case "Union":
      return type.params.flatMap(allTypeVars);

    case "Function":
      return allTypeVars(type.return).concat(type.params.flatMap(allTypeVars));
    case "Tuple":
      return type.types.flatMap(allTypeVars);
    case "Record":
    case "MutableRecord": {
      return [
        ...Object.values(type.fields).flatMap(allTypeVars),
        ...(type.baseType ? allTypeVars(type.baseType) : []),
      ];
    }
    case "Unknown":
    case "Unit":
    case "InProgressBinding":
      return [];
  }
}

function anyTypeVar(type: Type, predicate: (tvar: TVar) => boolean): boolean {
  let result = false;
  switch (type.nodeType) {
    case "Var":
      result = predicate(type);
      break;
    case "Tuple":
      result = type.types.some((param) => anyTypeVar(param, predicate));
      break;
    case "Union":
      result = type.params.some((param) => anyTypeVar(param, predicate));
      break;
    case "Function":
      result =
        anyTypeVar(type.return, predicate) ||
        type.params.some((param) => anyTypeVar(param, predicate));
      break;
    case "Record":
    case "MutableRecord":
      result =
        Object.values(type.fields).some((field) =>
          anyTypeVar(field, predicate),
        ) || (type.baseType ? anyTypeVar(type.baseType, predicate) : false);
      break;
    case "Unit":
    case "Unknown":
    case "InProgressBinding":
      result = false;
      break;
  }

  return (
    result ||
    type.alias?.parameters.some((param) => anyTypeVar(param, predicate)) ===
      true
  );
}

/**
 * Curry function helper
 * @param func The function type to curry
 * @param count The number params to partially apply
 */
export function curryFunction(func: TFunction, count: number): Type {
  if (count < func.params.length) {
    return TFunction(func.params.slice(count), func.return);
  } else {
    return func.return;
  }
}

/**
 * Uncurry function helper
 * @param func The function type to uncurry
 */
export function uncurryFunction(func: TFunction): TFunction {
  if (func.return.nodeType === "Function") {
    return TFunction(
      [...func.params, ...func.return.params],
      func.return.return,
    );
  } else {
    return func;
  }
}

function getParentPatternDeclaration(
  ref: Expression,
): EValueDeclaration | undefined {
  const parentPattern = mapSyntaxNodeToExpression(
    TreeUtils.findParentOfType("value_declaration", ref),
  );

  if (parentPattern?.nodeType !== "ValueDeclaration") {
    throw new Error(`Failed to get parent pattern declaration`);
  }

  return parentPattern.pattern ? parentPattern : undefined;
}

export function getTypeclassName(type: TVar): string | undefined {
  if (type.name.length < 6) {
    return;
  } else if (type.name.startsWith("number")) {
    return "number";
  } else if (type.name.startsWith("appendable")) {
    return "appendable";
  } else if (type.name.startsWith("comparable")) {
    return "comparable";
  } else if (type.name.startsWith("compappend")) {
    return "compappend";
  }
}

const VAR_LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function getVarNames(count: number): string[] {
  const names = [];
  for (let i = 0; i < count; i++) {
    const letter = VAR_LETTERS[i % 26];
    if (i < 26) {
      names.push(letter);
    } else {
      names.push(`${letter}${i / 26}`);
    }
  }
  return names;
}

export function nthVarName(n: number): string {
  return getVarNames(n)[n - 1];
}

function typeMismatchError(
  checker: TypeChecker,
  node: SyntaxNode,
  found: Type,
  expected: Type,
  endNode?: SyntaxNode,
  patternBinding = false,
  recordDiff?: RecordDiff,
): Diagnostic {
  const foundText = checker.typeToString(found);
  const expectedText = checker.typeToString(expected);

  const diagnostic = patternBinding
    ? error(node, Diagnostics.InvalidPattern, expectedText, foundText)
    : error(node, Diagnostics.TypeMismatch, expectedText, foundText);

  const recordDiffText = (diff: RecordDiff): string => {
    let s = "";

    if (diff.extra.size > 0) {
      s += `\nExtra fields: \`${checker.typeToString(
        TRecord(Object.fromEntries(diff.extra.entries())),
      )}\``;
    }
    if (diff.missing.size > 0) {
      s += `\nMissing fields: \`${checker.typeToString(
        TRecord(Object.fromEntries(diff.missing.entries())),
      )}\``;
    }
    if (diff.mismatched.size > 0) {
      s += `\nMismatched fields: `;
      diff.mismatched.forEach(([found, expected], field) => {
        s += `\n Field \`${field}\` expected \`${checker.typeToString(
          expected,
        )}\`, found \`${checker.typeToString(found)}\``;
      });
    }

    return s;
  };

  if (recordDiff) {
    diagnostic.message += recordDiffText(recordDiff);
  }

  return diagnostic;
}

function parameterCountError(
  node: SyntaxNode,
  endNode: SyntaxNode,
  actual: number,
  expected: number,
  isType = false,
): Diagnostic {
  const name = node.firstNamedChild?.text ?? "";
  return errorWithEndNode(
    node,
    Diagnostics.ParameterCountError,
    endNode,
    isType ? "type" : "function",
    name,
    expected,
    actual,
  );
}

function argumentCountError(
  node: SyntaxNode,
  endNode: SyntaxNode,
  actual: number,
  expected: number,
  isType = false,
): Diagnostic {
  if (expected === 0 && !isType) {
    const name = node.firstNamedChild?.text;
    return errorWithEndNode(
      node,
      Diagnostics.ArgumentCount,
      endNode,
      name ?? "This value",
      actual,
    );
  } else {
    return parameterCountError(node, endNode, actual, expected, isType);
  }
}

interface RecordDiff {
  extra: Map<string, Type>;
  missing: Map<string, Type>;
  mismatched: Map<string, [Type, Type]>;
  isEmpty: boolean;
}

const RecordDiff = (
  extra: Map<string, Type>,
  missing: Map<string, Type>,
  mismatched: Map<string, [Type, Type]>,
): RecordDiff => {
  return {
    extra,
    missing,
    mismatched,
    isEmpty: extra.size === 0 && missing.size === 0 && mismatched.size === 0,
  };
};

export interface InferenceResult {
  expressionTypes: SyntaxNodeMap<Expression, Type>;
  diagnostics: Diagnostic[];
  type: Type;
  recordDiffs: SyntaxNodeMap<Expression, RecordDiff>;
}

export class InferenceScope {
  private expressionTypes: SyntaxNodeMap<Expression, Type> =
    new SyntaxNodeMap();
  private diagnostics: Diagnostic[] = [];

  private bindings: SyntaxNodeMap<SyntaxNode, Type> = new SyntaxNodeMap<
    SyntaxNode,
    Type
  >();
  private replacements: DisjointSet;

  private annotationVars: TVar[] = [];

  public ancestors: Sequence<InferenceScope>;

  private resolvedDeclarations: SyntaxNodeMap<EValueDeclaration, Type>;

  private childDeclarations = new Set<EValueDeclaration>();

  private recordDiffs: SyntaxNodeMap<Expression, RecordDiff> =
    new SyntaxNodeMap();

  private typeChecker: TypeChecker;

  constructor(
    private uri: string,
    private program: IProgram,
    private nonShadowableNames: Set<string>,
    private activeScopes: Set<EValueDeclaration>,
    private recursionAllowed: boolean,
    private cancellationToken?: ICancellationToken,
    private parent?: InferenceScope,
  ) {
    this.replacements = parent?.replacements ?? new DisjointSet();

    this.resolvedDeclarations =
      parent?.resolvedDeclarations ??
      new SyntaxNodeMap<EValueDeclaration, Type>();

    this.ancestors = new Sequence(
      this,
      (scope: InferenceScope) => scope.parent,
    );

    this.typeChecker = program.getTypeChecker();
  }

  private getBinding(e: Expression): Type | undefined {
    return this.ancestors
      .map((a) => a.bindings.get(e))
      .find(Utils.notUndefined);
  }

  public static valueDeclarationInference(
    declaration: EValueDeclaration,
    uri: string,
    program: IProgram,
    activeScopes: Set<EValueDeclaration>,
    recursionAllowed = false,
    cancellationToken?: ICancellationToken,
  ): InferenceResult {
    const nonShadowableNames =
      new Set(program.getSourceFile(uri)?.nonShadowableNames) ??
      new Set<string>();

    const setter = (): InferenceResult =>
      new InferenceScope(
        uri,
        program,
        nonShadowableNames,
        new Set(activeScopes.values()),
        recursionAllowed,
        cancellationToken,
      ).inferDeclaration(declaration, true);

    const start = performance.now();
    try {
      if (!program.getForest().getByUri(uri)?.writeable) {
        return program
          .getTypeCache()
          .getOrSet("PACKAGE_VALUE_DECLARATION", declaration, setter);
      } else {
        return program
          .getTypeCache()
          .getOrSet("PROJECT_VALUE_DECLARATION", declaration, setter);
      }
    } finally {
      inferTime += performance.now() - start;
    }
  }

  private inferDeclaration(
    declaration: EValueDeclaration,
    replaceExpressionTypes: boolean,
  ): InferenceResult {
    this.activeScopes.add(declaration);

    // Bind the parameters so the body can reference them
    const binding = this.bindParameters(declaration);

    // If there is a pattern, it gets inferred in the parameter binding
    if (declaration.pattern) {
      return this.toTopLevelResult(TUnknown);
    }

    let bodyType: Type = TUnknown;
    if (declaration.body) {
      const mappedBody = mapSyntaxNodeToExpression(
        declaration.body,
      ) as Expression;
      bodyType = this.infer(mappedBody);

      // Make sure the returned type is what is annotated
      if (binding.bindingType === "Annotated") {
        const bindingType = (<Annotated>binding).type;
        const expected =
          bindingType.nodeType === "Function"
            ? curryFunction(bindingType, binding.count)
            : bindingType;
        this.isAssignable(mappedBody, bodyType, expected);
      } else {
        this.checkTopLevelCaseBranches(mappedBody, bodyType);
      }
    }

    const type: Type =
      binding.bindingType === "Annotated"
        ? (<Annotated>binding).type
        : binding.bindingType === "Unannotated"
        ? binding.count === 0
          ? bodyType
          : uncurryFunction(TFunction((<Unannotated>binding).params, bodyType))
        : bodyType;

    return this.toTopLevelResult(type, replaceExpressionTypes);
  }

  private checkTopLevelCaseBranches(expr: Expression, exprType: Type): void {
    if (expr.nodeType === "CaseOfExpr") {
      this.isBranchesAssignable(expr, exprType, TUnknown);
    }
  }

  private checkRecursion(declaration: EValueDeclaration): boolean {
    let scopes = Array.from(this.activeScopes.values());
    const index = scopes.findIndex((decl) => decl.id === declaration.id);

    const isRecursive = index >= 0;

    if (isRecursive) {
      // We only want scopes in the recursion loop
      scopes = scopes.slice(index);
    }

    // Handle top level declaration recursion
    if (
      isRecursive &&
      !this.recursionAllowed &&
      declaration.parent?.type === "file"
    ) {
      const callChain = scopes.filter(
        (decl) => decl.parent?.id === declaration.parent?.id,
      );

      if (callChain.every((decl) => decl.params.length === 0)) {
        const mapped = callChain.map(
          (decl) => decl.firstNamedChild?.firstNamedChild?.text ?? "",
        );

        this.diagnostics.push(
          error(
            declaration.firstNamedChild!,
            Diagnostics.RecursiveDeclaration(mapped.length),
            ...mapped,
          ),
        );
      }
    }

    // Handle let recursion
    if (isRecursive && declaration.parent?.type === "let_in_expr") {
      const callChain = scopes
        .filter((decl) => decl.parent?.id === declaration.parent?.id)
        .reverse();

      const recursiveLet = callChain.find((decl) => decl.params.length === 0);

      if (recursiveLet?.firstNamedChild) {
        const reversed = callChain
          .reverse()
          .map((decl) => decl.firstNamedChild?.firstNamedChild?.text ?? "");

        const rotated = Utils.rotateArray(
          reversed,
          reversed.indexOf(recursiveLet.firstNamedChild.text),
        );

        this.diagnostics.push(
          error(
            recursiveLet.firstNamedChild,
            Diagnostics.RecursiveLet(callChain.length),
            ...rotated,
          ),
        );
      }
    }

    return isRecursive;
  }

  private toTopLevelResult(
    type: Type,
    replaceExpressionTypes = true,
  ): InferenceResult {
    if (replaceExpressionTypes) {
      this.expressionTypes.mapValues((val) => {
        const result = TypeReplacement.replace(val, this.replacements.toMap());
        TypeReplacement.freeze(result);
        return result;
      });
    }

    const outerVars = this.ancestors
      .toArray()
      .slice(1)
      .flatMap((a) => a.annotationVars);

    const ret = TypeReplacement.replace(
      type,
      this.replacements.toMap(),
      false,
      outerVars,
    );

    if (replaceExpressionTypes) {
      TypeReplacement.freeze(ret);
    }

    return {
      expressionTypes: this.expressionTypes,
      diagnostics: this.diagnostics,
      type: ret,
      recordDiffs: this.recordDiffs,
    };
  }

  private infer(e: Expression): Type {
    let type: Type = TUnknown;

    this.cancellationToken?.throwIfCancellationRequested();

    switch (e.nodeType) {
      case "AnonymousFunctionExpr":
        type = this.inferLambda(e);
        break;
      case "BinOpExpr":
        type = this.inferBinOpExpr(e);
        break;
      case "CaseOfExpr":
        type = this.inferCase(e);
        break;
      case "CharConstantExpr":
        type = TChar();
        break;
      case "FieldAccessExpr":
        type = this.inferFieldAccess(e);
        break;
      case "FieldAccessorFunctionExpr":
        type = this.inferFieldAccessorFunctionExpr(e);
        break;
      case "FunctionCallExpr":
        type = this.inferFunctionCallExpr(e);
        break;
      case "GlslCodeExpr":
        type = TShader();
        break;
      case "IfElseExpr":
        type = this.inferIfElse(e);
        break;
      case "LetInExpr":
        type = this.inferChild((inference) => inference.letInInference(e)).type;
        break;
      case "ListExpr":
        type = this.inferList(e);
        break;
      case "NegateExpr":
        type = this.inferNegateExpr(e);
        break;
      case "NumberConstant":
        type = e.isFloat ? TFloat() : TNumber();
        break;
      case "OperatorAsFunctionExpr":
        type = this.inferOperatorAsFunctionExpr(e);
        break;
      case "RecordExpr":
        type = this.inferRecord(e);
        break;
      case "StringConstant":
        type = TString();
        break;
      case "TupleExpr":
        type = TTuple(e.exprList.map((expr) => this.infer(expr)));
        break;
      case "UnitExpr":
        type = TUnit;
        break;
      case "ValueExpr":
        type = this.inferReferenceElement(e);
        break;
      default:
        throw new Error("Unexpected Expression type");
    }

    this.expressionTypes.set(e, type);
    return type;
  }

  private lambdaInference(lamba: EAnonymousFunctionExpr): InferenceResult {
    const paramVars = this.uniqueVars(lamba.params.length);
    lamba.params.forEach((p, i) => this.bindPattern(p, paramVars[i], true));

    const bodyType = this.infer(lamba.expr);
    this.checkTopLevelCaseBranches(lamba.expr, bodyType);

    return {
      expressionTypes: this.expressionTypes,
      diagnostics: this.diagnostics,
      type: uncurryFunction(TFunction(paramVars, bodyType)),
      recordDiffs: this.recordDiffs,
    };
  }

  private letInInference(letInExpr: ELetInExpr): InferenceResult {
    const valueDeclarations = letInExpr.valueDeclarations;
    valueDeclarations.forEach((v) => this.childDeclarations.add(v));

    valueDeclarations.forEach((declaration) => {
      if (!this.resolvedDeclarations.has(declaration)) {
        this.inferChildDeclaration(declaration);
      }
    });

    const bodyType = this.infer(letInExpr.body);
    this.checkTopLevelCaseBranches(letInExpr.body, bodyType);

    return {
      expressionTypes: this.expressionTypes,
      diagnostics: this.diagnostics,
      type: bodyType,
      recordDiffs: this.recordDiffs,
    };
  }

  private caseBranchInference(
    pattern: EPattern,
    caseType: Type,
    branchExpr: Expression,
  ): InferenceResult {
    this.bindPattern(pattern, caseType, false);
    const type = this.infer(branchExpr);
    return {
      expressionTypes: this.expressionTypes,
      diagnostics: this.diagnostics,
      type,
      recordDiffs: this.recordDiffs,
    };
  }

  private inferChild(
    callback: (inference: InferenceScope) => InferenceResult,
    activeScopes = new Set(this.activeScopes.values()),
    recursionAllowed = this.recursionAllowed,
  ): InferenceResult {
    const result = callback(
      new InferenceScope(
        this.uri,
        this.program,
        new Set(this.nonShadowableNames.values()),
        activeScopes,
        recursionAllowed,
        this.cancellationToken,
        this,
      ),
    );

    this.diagnostics.push(...result.diagnostics);

    result.recordDiffs.forEach((val, key) => this.recordDiffs.set(key, val));

    result.expressionTypes.forEach((val, key) =>
      this.expressionTypes.set(key, val),
    );

    return result;
  }

  private inferChildDeclaration(
    declaration: EValueDeclaration,
    activeScopes = this.activeScopes,
  ): InferenceResult {
    const result = this.inferChild(
      (inference) => inference.inferDeclaration(declaration, false),
      new Set(activeScopes.values()),
      /* recursionAllowed */ declaration.params.length > 0,
    );

    this.resolvedDeclarations.set(declaration, result.type);
    this.expressionTypes.set(declaration, result.type);

    const funcName =
      TreeUtils.getFunctionNameNodeFromDefinition(declaration)?.text;

    if (funcName) {
      this.nonShadowableNames.add(funcName);
    } else {
      const pattern = declaration.pattern;

      if (pattern) {
        const patterns = pattern
          .descendantsOfType("lower_pattern")
          ?.map(mapSyntaxNodeToExpression)
          .filter(Utils.notUndefined);

        patterns?.forEach((pat) => {
          const patType = result.expressionTypes.get(pat);
          if (patType) {
            this.setBinding(pat, patType);
          }
          this.nonShadowableNames.add(pat.text);
        });
      }
    }

    return result;
  }

  private inferList(expr: EListExpr): Type {
    const exprTypes = expr.exprList.map((e) => this.infer(e));

    for (let i = 1; i < expr.exprList.length; i++) {
      if (this.isAssignable(expr.exprList[i], exprTypes[i], exprTypes[0])) {
        this.expressionTypes.set(expr.exprList[i], exprTypes[0]);
      } else {
        break;
      }
    }

    return TList(exprTypes[0] ?? TVar("a"));
  }

  private inferIfElse(ifElseExpr: EIfElseExpr): Type {
    const exprList = ifElseExpr.exprList;

    // Check for incomplete program
    if (exprList.length < 3 || exprList.length % 2 == 0) {
      return TUnknown;
    }

    const exprTypes = exprList.map((e) => this.infer(e));

    // Check all conditions are type Bool
    for (let i = 0; i < exprList.length - 1; i += 2) {
      this.isAssignable(exprList[i], exprTypes[i], TBool());
    }

    // Check that all branches match the first one
    for (let i = 0; i < exprList.length; i++) {
      if (i != exprList.length - 1 && (i < 3 || i % 2 == 0)) {
        continue;
      }

      if (!this.isAssignable(exprList[i], exprTypes[i], exprTypes[1])) {
        break;
      }
    }

    return exprTypes[1];
  }

  private inferReferenceElement(e: Expression): Type {
    let definition = findDefinition(
      e.firstNamedChild?.lastNamedChild,
      this.program,
    );
    if (!definition.expr && definition.diagnostics.length === 0) {
      definition = findDefinition(e.firstNamedChild, this.program);
    }

    this.diagnostics.push(...definition.diagnostics);

    if (!definition.expr) {
      const sourceFile = this.program.getSourceFile(e.tree.uri);
      if (
        nameIsKernel(e.text) &&
        sourceFile &&
        isKernelProject(sourceFile.project)
      ) {
        return TUnknown;
      }

      if (definition.diagnostics.length === 0) {
        this.diagnostics.push(error(e, Diagnostics.MissingValue, e.text));
      }

      return TVar("a");
    }

    const binding = this.getBinding(definition.expr);

    if (binding) {
      if (binding.nodeType === "InProgressBinding") {
        this.diagnostics.push(error(e, Diagnostics.CyclicDefinition));
        return TUnknown;
      } else {
        return binding;
      }
    }

    switch (definition.expr.nodeType) {
      case "FunctionDeclarationLeft": {
        const valueDeclaration = mapSyntaxNodeToExpression(
          TreeUtils.findParentOfType("value_declaration", definition.expr),
        );

        if (valueDeclaration?.nodeType !== "ValueDeclaration") {
          throw new Error("Could not find parent value declaration");
        }
        return this.inferReferencedValueDeclaration(valueDeclaration);
      }
      case "LowerPattern": {
        const parentPattern = getParentPatternDeclaration(definition.expr);
        if (parentPattern) {
          this.inferReferencedValueDeclaration(parentPattern);

          const binding = this.getBinding(definition.expr);

          if (binding) {
            return binding;
          } else {
            throw new Error("Failed to destructure pattern");
          }
        }

        throw new Error("Failed to bind pattern");
      }
      case "UnionVariant": {
        return TypeExpression.unionVariantInference(
          definition.expr,
          this.program,
        ).type;
      }
      case "TypeAliasDeclaration": {
        const ty = TypeExpression.typeAliasDeclarationInference(
          definition.expr,
          this.program,
        ).type;
        if (ty.nodeType === "Record" && Object.keys(ty.fields).length > 0) {
          return TFunction(Object.values(ty.fields), ty);
        } else {
          return ty;
        }
      }
      case "FieldType": {
        const typeAlias = mapSyntaxNodeToExpression(
          TreeUtils.findParentOfType("type_alias_declaration", definition.expr),
        );

        if (typeAlias && typeAlias.nodeType === "TypeAliasDeclaration") {
          const fields = (
            TypeExpression.typeAliasDeclarationInference(
              typeAlias,
              this.program,
            ).type as TRecord
          )?.fields;

          if (fields) {
            return fields[definition.expr.text];
          }
        }

        return TUnknown;
      }
      case "PortAnnotation": {
        return TypeExpression.portAnnotationInference(
          definition.expr,
          this.program,
        ).type;
      }
      default:
        throw new Error("Unexpected reference type");
    }
  }

  private inferReferencedValueDeclaration(
    declaration: EValueDeclaration | undefined,
  ): Type {
    if (!declaration) {
      return TUnknown;
    }

    const recursive = this.checkRecursion(declaration);

    const existing = this.resolvedDeclarations.get(declaration);

    if (existing) {
      return TypeReplacement.freshenVars(existing);
    }

    let type: Type | undefined;
    // Get the type annotation if there is one
    if (declaration.typeAnnotation) {
      type = TypeExpression.typeAnnotationInference(
        mapSyntaxNodeToExpression(
          declaration.typeAnnotation,
        ) as ETypeAnnotation,
        this.program,
        false,
      )?.type;
    }

    if (!type) {
      // Don't try to infer unannotated recursive functions
      if (recursive) {
        return TUnknown;
      }

      const parentScope = this.ancestors.find(
        (scope) =>
          !!Array.from(scope.childDeclarations.values()).find(
            (child) => child.id === declaration.id,
          ),
      );

      type = !parentScope
        ? InferenceScope.valueDeclarationInference(
            declaration,
            declaration.tree.uri,
            this.program,
            this.activeScopes,
            this.recursionAllowed,
            this.cancellationToken,
          ).type
        : parentScope.inferChildDeclaration(declaration, this.activeScopes)
            .type;
    }

    this.resolvedDeclarations.set(declaration, type);
    return type;
  }

  private inferFunctionCallExpr(e: EFunctionCallExpr): Type {
    const targetType = this.infer(e.target);
    const argTypes = e.args.map((arg) => this.infer(arg));

    const argCountError = (
      expr: Expression,
      endExpr: Expression,
      actual: number,
      expected: number,
    ): TUnknown => {
      this.diagnostics.push(
        argumentCountError(expr, endExpr, actual, expected),
      );
      return TUnknown;
    };

    if (targetType.nodeType === "Var") {
      const type = TFunction(argTypes, TVar("a"));

      if (this.isAssignable(e.target, targetType, type)) {
        return type.return;
      } else {
        return TUnknown;
      }
    }

    if (targetType.nodeType === "Unknown") {
      const type = TFunction(argTypes, TVar("a"));

      if (this.isAssignable(e.target, targetType, type)) {
        this.expressionTypes.set(e.target, type);
        return type.return;
      } else {
        return TUnknown;
      }
    }

    if (targetType.nodeType !== "Function") {
      return argCountError(e, e, e.args.length, 0);
    }

    let allAssignable = true;

    // Make sure each arg is assignable to the inferred type
    for (
      let i = 0;
      i < Math.min(e.args.length, targetType.params.length);
      i++
    ) {
      allAssignable =
        this.isAssignable(e.args[i], argTypes[i], targetType.params[i]) &&
        allAssignable;
    }

    if (allAssignable && e.args.length > targetType.params.length) {
      let appliedType = TypeReplacement.replace(
        targetType.return,
        this.replacements.toMap(),
      );

      if (appliedType.nodeType !== "Function") {
        return argCountError(e, e, e.args.length, targetType.params.length);
      }

      for (let i = targetType.params.length; i < e.args.length; i++) {
        if (appliedType.nodeType !== "Function") {
          return argCountError(e.target, e.args[i], 1, 0);
        }

        if (!this.isAssignable(e.args[i], argTypes[i], appliedType.params[0])) {
          return TUnknown;
        }

        appliedType = TypeReplacement.replace(
          curryFunction(appliedType, 1),
          this.replacements.toMap(),
        );
      }

      this.expressionTypes.set(e, appliedType);
      return appliedType;
    }

    const resultType: Type = allAssignable
      ? TypeReplacement.replace(
          curryFunction(targetType, e.args.length),
          this.replacements.toMap(),
          true,
        )
      : TUnknown;

    this.expressionTypes.set(e, resultType);
    return resultType;
  }

  private inferBinOpExpr(e: EBinOpExpr): Type {
    const operatorPrecedences = new SyntaxNodeMap<
      Expression,
      IOperatorPrecedence
    >();
    const operatorTypes = new SyntaxNodeMap<Expression, TFunction>();

    let lastPrecedence: IOperatorPrecedence | undefined;

    for (const part of e.parts) {
      if (part.nodeType === "Operator") {
        const [type, precedence] = this.inferOperatorAndPrecedence(part);
        if (type.nodeType !== "Function" || type.params.length < 2) {
          throw new Error("Could not find operator function");
        }

        if (
          precedence.associativity === "NON" &&
          lastPrecedence?.associativity === "NON"
        ) {
          this.diagnostics.push(error(e, Diagnostics.NonAssociativeOperator));
          return TUnknown;
        }

        operatorPrecedences.set(part, precedence);
        operatorTypes.set(part, type);

        lastPrecedence = precedence;
      }
    }

    const validateTree = (
      tree: BinaryExprTree,
    ): { start: Expression; end: Expression; type: Type } => {
      switch (tree.type) {
        case "Operand": {
          const operandTree = <Operand>tree;
          const type = this.inferOperand(operandTree.operand);
          return { start: operandTree.operand, end: operandTree.operand, type };
        }
        case "Binary": {
          const binaryTree = <Binary>tree;
          const left = validateTree(binaryTree.left);
          const right = validateTree(binaryTree.right);
          const func = operatorTypes.get(binaryTree.operator);

          if (!func) {
            throw new Error("Missing function type for operator");
          }

          const leftAssignable = this.isAssignable(
            left.start,
            left.type,
            func.params[0],
            left.end,
          );
          const rightAssignable = this.isAssignable(
            right.start,
            right.type,
            func.params[1],
            right.end,
          );

          const type: Type =
            leftAssignable && rightAssignable
              ? TypeReplacement.replace(
                  curryFunction(func, 2),
                  this.replacements.toMap(),
                  true,
                )
              : TUnknown;

          return { start: left.start, end: right.end, type };
        }
      }
    };

    const result = validateTree(
      BinaryExprTree.parse(e.parts, operatorPrecedences),
    );

    this.expressionTypes.set(e, result.type);

    return result.type;
  }

  private inferOperand(e: Expression): Type {
    if (e.nodeType === "FunctionCallExpr") {
      return this.inferFunctionCallExpr(e);
    }

    return this.infer(e);
  }

  private inferOperatorAndPrecedence(
    e: EOperator,
  ): [Type, IOperatorPrecedence] {
    // Find operator reference
    const definition = findDefinition(e, this.program);

    const opDeclaration = mapSyntaxNodeToExpression(definition.expr?.parent);

    const infixDeclarationExpr = mapSyntaxNodeToExpression(
      opDeclaration
        ? References.findOperator(opDeclaration, this.program)
        : undefined,
    );

    if (
      opDeclaration?.nodeType !== "ValueDeclaration" ||
      infixDeclarationExpr?.nodeType !== "InfixDeclaration" ||
      !definition
    ) {
      return [TUnknown, { precedence: 0, associativity: "NON" }];
    }

    const type = this.inferReferencedValueDeclaration(opDeclaration);

    this.expressionTypes.set(e, type);
    return [
      type,
      {
        precedence: infixDeclarationExpr.precedence,
        associativity: infixDeclarationExpr.associativity,
      },
    ];
  }

  private inferFieldAccessorFunctionExpr(
    accessor: EFieldAccessorFunctionExpr,
  ): Type {
    const field =
      TreeUtils.findFirstNamedChildOfType("lower_case_identifier", accessor)
        ?.text ?? "";
    const typeVar = TVar("b");
    return TFunction(
      [TMutableRecord({ [field]: typeVar }, TVar("a"))],
      typeVar,
    );
  }

  private inferNegateExpr(negateExpr: ENegateExpr): Type {
    const exprType = this.infer(negateExpr.expression);
    if (this.isAssignable(negateExpr.expression, exprType, TNumber())) {
      return exprType;
    } else {
      return TUnknown;
    }
  }

  private inferOperatorAsFunctionExpr(
    operatorFunction: EOperatorAsFunctionExpr,
  ): Type {
    // Find operator reference
    const definition = findDefinition(operatorFunction.operator, this.program);

    const opDeclaration = mapSyntaxNodeToExpression(definition.expr?.parent);

    if (opDeclaration?.nodeType === "ValueDeclaration" && definition?.expr) {
      return this.inferReferencedValueDeclaration(opDeclaration);
    } else {
      return TUnknown;
    }
  }

  private inferFieldAccess(expr: EFieldAccessExpr): Type {
    const targetType = this.inferFieldAccessTarget(expr.target);
    const targetTy = this.replacements.get(targetType);
    const fieldIdentifier = TreeUtils.findFirstNamedChildOfType(
      "lower_case_identifier",
      expr,
    );

    if (!fieldIdentifier) {
      return TUnknown;
    }

    const fieldIdentifierText = fieldIdentifier.text;

    if (fieldIdentifierText === "") {
      return TUnknown;
    }

    if (targetTy?.nodeType === "Var") {
      if (targetTy.rigid) {
        const typeString = this.program.getTypeChecker().typeToString(targetTy);
        this.diagnostics.push(
          error(expr.target, Diagnostics.RecordBaseId, typeString),
        );
        return TUnknown;
      }

      const type = TVar("b");
      this.trackReplacement(
        targetType,
        TMutableRecord({ [fieldIdentifierText]: type }, TVar("a")),
      );
      this.expressionTypes.set(expr, type);
      return type;
    }

    if (targetTy?.nodeType === "MutableRecord") {
      let type = targetTy.fields[fieldIdentifierText];
      if (!type) {
        targetTy.fields[fieldIdentifierText] = TVar(
          nthVarName(Object.keys(targetTy.fields).length),
        );
        type = targetTy.fields[fieldIdentifierText];
      }

      this.expressionTypes.set(expr, type);

      return type;
    }

    if (targetTy?.nodeType !== "Record") {
      if (targetTy?.nodeType !== "Unknown" && targetTy) {
        this.diagnostics.push(
          error(
            expr.target,
            Diagnostics.FieldAccessOnNonRecord,
            this.typeChecker.typeToString(targetTy),
          ),
        );
      }
      return TUnknown;
    }

    if (!Object.keys(targetTy.fields).includes(fieldIdentifierText)) {
      if (!targetTy.baseType) {
        this.diagnostics.push(
          error(fieldIdentifier, Diagnostics.RecordField, fieldIdentifierText),
        );
      }
    }

    const type = targetTy.fields[fieldIdentifierText] ?? TVar("a");
    this.expressionTypes.set(expr, type);
    return type;
  }

  private inferFieldAccessTarget(target: Expression): Type {
    let type: Type = TUnknown;
    switch (target.nodeType) {
      case "ValueExpr":
        type = this.inferReferenceElement(target);
        break;
      case "RecordExpr":
        type = this.inferRecord(target);
        break;
      case "FieldAccessExpr":
        type = this.inferFieldAccess(target);
        break;
      default:
        if (target.parent?.type === "parenthesized_expr") {
          type = this.infer(target);
        } else {
          throw new Error("Unexpected field access target expression");
        }
    }

    this.expressionTypes.set(target, type);
    return type;
  }

  private inferLambda(lambaExpr: EAnonymousFunctionExpr): Type {
    return this.inferChild(
      (inference) => inference.lambdaInference(lambaExpr),
      /* activeScopes */ undefined,
      /* recursionAllowed */ true,
    ).type;
  }

  private inferCase(caseOfExpr: ECaseOfExpr): Type {
    const caseOfExprType = this.infer(caseOfExpr.expr);

    let type: Type | undefined;

    caseOfExpr.branches.forEach((branch) => {
      const result = this.inferChild((inference) =>
        inference.caseBranchInference(
          branch.pattern,
          caseOfExprType,
          branch.expr,
        ),
      );

      if (!type) {
        type = result.type;
      }
    });

    this.diagnostics.push(
      ...PatternMatches.check(
        caseOfExpr,
        caseOfExpr.branches.map((branch) => branch.pattern),
        this.program,
      ),
    );

    return type ?? TUnknown;
  }

  private inferRecord(record: ERecordExpr): Type {
    const fields = new Map(
      record.fields.map((field) => [field.name, this.infer(field.expression)]),
    );

    const mappedFields: { [name: string]: Type } = {};
    fields.forEach((type, field) => (mappedFields[field.text] = type));

    const recordIdentifier = record.baseRecord as Expression;

    if (!recordIdentifier) {
      return TRecord(mappedFields);
    }

    const baseType = this.inferReferenceElement(recordIdentifier);

    if (baseType.nodeType === "Unknown") {
      return TUnknown;
    }

    if (baseType.nodeType === "Var") {
      const extRecord = TRecord(mappedFields, TVar(baseType.name));
      if (this.isAssignable(recordIdentifier, baseType, extRecord)) {
        return extRecord;
      } else {
        return TUnknown;
      }
    }

    let baseFields: { [name: string]: Type } = {};

    if (
      baseType.nodeType === "Record" ||
      baseType.nodeType === "MutableRecord"
    ) {
      baseFields = baseType.fields;
    } else {
      this.diagnostics.push(
        error(
          recordIdentifier,
          Diagnostics.RecordBaseId,
          this.typeChecker.typeToString(baseType),
        ),
      );
      return TUnknown;
    }

    fields.forEach((type, field) => {
      const fieldText = field.text;
      const expected = baseFields[fieldText];
      if (!expected) {
        if (baseType.nodeType === "Record") {
          if (!baseType.baseType) {
            this.diagnostics.push(
              error(field, Diagnostics.RecordField, fieldText),
            );
            this.recordDiffs.set(
              record,
              this.calculateRecordDiff(TRecord(mappedFields), baseType),
            );
            this.expressionTypes.set(field, type);
          }
        } else if (baseType.nodeType === "MutableRecord") {
          baseType.fields[fieldText] = type;
        }
      } else {
        this.isAssignable(field, type, expected);
      }
    });

    return baseType;
  }

  private setBinding(expr: Expression, type: Type): void {
    const exprName = expr.text;
    if (this.nonShadowableNames.has(exprName)) {
      this.diagnostics.push(error(expr, Diagnostics.Redefinition, expr.text));
    }

    this.nonShadowableNames.add(exprName);

    this.bindings.set(expr, type);
    this.expressionTypes.set(expr, type);
  }

  private bindParameters(
    valueDeclaration: EValueDeclaration,
  ): ParameterBindingResult {
    const functionDeclarationLeft = mapSyntaxNodeToExpression(
      valueDeclaration.childForFieldName("functionDeclarationLeft"),
    ) as EFunctionDeclarationLeft;

    if (functionDeclarationLeft) {
      return this.bindFunctionDeclarationParameters(
        valueDeclaration,
        functionDeclarationLeft,
      );
    }

    if (valueDeclaration.pattern) {
      this.bindPatternDeclarationParameters(
        valueDeclaration,
        mapSyntaxNodeToExpression(valueDeclaration.pattern) as EPattern,
      );
      return { bindingType: "Other", count: 0 };
    }

    return { bindingType: "Other", count: 0 };
  }

  private bindFunctionDeclarationParameters(
    valueDeclaration: EValueDeclaration,
    functionDeclaration: EFunctionDeclarationLeft,
  ): ParameterBindingResult {
    const typeRefResult = valueDeclaration.typeAnnotation
      ? TypeExpression.typeAnnotationInference(
          mapSyntaxNodeToExpression(
            valueDeclaration.typeAnnotation,
          ) as ETypeAnnotation,
          this.program,
          true,
        )
      : undefined;

    const patterns = functionDeclaration.params;

    if (!typeRefResult) {
      const params = this.uniqueVars(patterns.length);
      patterns.forEach((pat, i) => this.bindPattern(pat, params[i], true));
      return {
        bindingType: "Unannotated",
        params,
        count: params.length,
      } as Unannotated;
    }

    this.diagnostics.push(...typeRefResult.diagnostics);
    const typeRefType = typeRefResult.type;

    const maxParams =
      typeRefType.nodeType === "Function" ? typeRefType.params.length : 0;

    if (patterns.length > maxParams) {
      this.diagnostics.push(
        parameterCountError(
          patterns[0],
          patterns[patterns.length - 1],
          patterns.length,
          maxParams,
        ),
      );
      patterns.forEach((pat) => this.bindPattern(pat, TUnknown, true));
      return { count: maxParams } as Other;
    }

    if (typeRefType.nodeType === "Function") {
      patterns.forEach((pat, i) =>
        this.bindPattern(pat, typeRefType.params[i], true),
      );
    }

    this.annotationVars = allTypeVars(typeRefType);

    return {
      bindingType: "Annotated",
      type: typeRefType,
      count: patterns.length,
    } as Annotated;
  }

  private bindPatternDeclarationParameters(
    valueDeclaration: EValueDeclaration,
    pattern: EPattern,
  ): void {
    // Bind all patters to a InProgressBinding type
    // so we can use them before we know the type
    const declaredNames = pattern.descendantsOfType("lower_pattern");
    declaredNames.forEach((name) =>
      this.bindings.set(name, TInProgressBinding),
    );

    const bodyType: Type = valueDeclaration.body
      ? this.infer(
          mapSyntaxNodeToExpression(valueDeclaration.body) as Expression,
        )
      : TUnknown;
    this.bindPattern(pattern, bodyType, false);

    // Make sure there are none still in progress, or else there was a mistake
    declaredNames.forEach((name) => {
      if (
        this.getBinding(name as Expression)?.nodeType === "InProgressBinding"
      ) {
        throw new Error(`Failed to bind parameter ${name.text}`);
      }
    });
  }

  private bindPattern(
    pattern: Expression,
    type: Type,
    isParameter: boolean,
  ): void {
    const ty = this.replacements.get(type) ?? type;
    switch (pattern.nodeType) {
      case "AnythingPattern":
        break;
      case "ConsPattern":
        if (isParameter) {
          this.diagnostics.push(error(pattern, Diagnostics.PartialPattern));
          this.bindConsPattern(pattern, TUnknown);
        } else {
          this.bindConsPattern(pattern, ty);
        }
        break;
      case "LowerPattern":
        this.setBinding(pattern, ty);
        break;
      case "ListPattern":
        if (isParameter) {
          this.bindListPattern(pattern, TUnknown);
        } else {
          this.bindListPattern(pattern, ty);
        }
        break;
      case "Pattern":
        {
          const child = mapSyntaxNodeToExpression(
            pattern.childForFieldName("child"),
          );
          if (!child) {
            throw new Error("Missing pattern child");
          }

          this.bindPattern(child, ty, isParameter);
          if (pattern.patternAs) {
            this.bindPattern(pattern.patternAs, ty, isParameter);
          }
        }
        break;
      case "RecordPattern":
        this.bindRecordPattern(pattern, ty, isParameter);
        break;
      case "TuplePattern":
        this.bindTuplePattern(pattern, ty, isParameter);
        break;
      case "UnionPattern":
        this.bindUnionPattern(pattern, ty, isParameter);
        break;
      case "UnitExpr":
        this.isAssignable(pattern, ty, TUnit, undefined, true);
        break;
      case "StringConstant":
      case "NumberConstant":
      case "CharConstantExpr":
        if (isParameter) {
          this.diagnostics.push(error(pattern, Diagnostics.PartialPattern));
        }
        break;
      default:
        throw new Error("Unexpected pattern type: " + pattern.nodeType);
    }
  }

  private bindTuplePattern(
    tuplePattern: ETuplePattern,
    type: Type,
    isParameter: boolean,
  ): void {
    const patterns = tuplePattern.patterns;
    const ty = this.bindIfVar(
      tuplePattern,
      type,
      TTuple(this.uniqueVars(patterns.length)),
    );

    if (ty.nodeType !== "Tuple" || ty.types.length !== patterns.length) {
      patterns.forEach((pat) => this.bindPattern(pat, TUnknown, isParameter));

      if (ty.nodeType !== "Unknown") {
        const actualType = TTuple(this.uniqueVars(patterns.length));
        this.diagnostics.push(
          typeMismatchError(
            this.program.getTypeChecker(),
            tuplePattern,
            actualType,
            ty,
            tuplePattern,
            true,
          ),
        );
      }
      return;
    }

    patterns.forEach((pat, i) => {
      this.bindPattern(pat, ty.types[i], isParameter);
    });
  }

  private bindUnionPattern(
    unionPattern: EUnionPattern,
    type: Type,
    isParameter: boolean,
  ): void {
    const variant = findDefinition(
      unionPattern.constructor.lastNamedChild,
      this.program,
    );

    if (variant.expr?.nodeType !== "UnionVariant") {
      unionPattern.namedParams.forEach((p) => this.setBinding(p, TUnknown));
      this.diagnostics.push(
        error(
          unionPattern.constructor.lastNamedChild ?? unionPattern.constructor,
          Diagnostics.MissingValue,
          unionPattern.constructor.lastNamedChild?.text ?? "union variant",
        ),
      );
      return;
    }

    const variantType = TypeExpression.unionVariantInference(
      variant.expr,
      this.program,
    ).type;

    if (!variantType || variantType.nodeType === "Unknown") {
      unionPattern.namedParams.forEach((p) => this.setBinding(p, TUnknown));
      return;
    }

    const issueError = (actual: number, expected: number): void => {
      this.diagnostics.push(
        argumentCountError(unionPattern, unionPattern, actual, expected, true),
      );
      unionPattern.namedParams.forEach((p) => this.setBinding(p, TUnknown));
    };

    if (variantType.nodeType === "Function") {
      const ty = this.bindIfVar(unionPattern, type, variantType.return);
      if (this.isAssignable(unionPattern, ty, variantType.return)) {
        if (unionPattern.argPatterns.length !== variantType.params.length) {
          issueError(
            unionPattern.argPatterns.length,
            variantType.params.length,
          );
        } else {
          unionPattern.argPatterns.forEach((p, i) => {
            // The other type is a nullary constructor argument pattern, which doesn't bind anything
            if (
              p.type.includes("pattern") &&
              p.nodeType !== "NullaryConstructorArgumentPattern"
            ) {
              this.bindPattern(p, variantType.params[i], isParameter);
            }
          });
        }
      } else {
        unionPattern.namedParams.forEach((p) => this.setBinding(p, TUnknown));
      }
    } else {
      const ty = this.bindIfVar(unionPattern, type, variantType);
      if (
        this.isAssignable(unionPattern, ty, variantType) &&
        unionPattern.argPatterns.length > 0
      ) {
        issueError(unionPattern.argPatterns.length, 0);
      } else {
        unionPattern.namedParams.forEach((p) => this.setBinding(p, TUnknown));
      }
    }
  }

  private bindConsPattern(consPattern: EConsPattern, type: Type): void {
    this.bindListPatternParts(consPattern, consPattern.parts, type, true);
  }

  private bindListPattern(listPattern: EListPattern, type: Type): void {
    this.bindListPatternParts(listPattern, listPattern.parts, type, false);
  }

  private bindListPatternParts(
    listPattern: EListPattern | EConsPattern,
    parts: Expression[],
    type: Type,
    isCons: boolean,
  ): void {
    const ty = this.bindIfVar(listPattern, type, TList(TVar("a")));

    if (
      ty.nodeType === "Unknown" ||
      ty.nodeType !== "Union" ||
      !typeIsList(ty)
    ) {
      if (ty.nodeType !== "Unknown") {
        this.diagnostics.push(
          typeMismatchError(
            this.program.getTypeChecker(),
            listPattern,
            TList(TVar("a")),
            ty,
            listPattern,
            true,
          ),
        );
      }

      parts.forEach((p) => this.bindPattern(p, TUnknown, false));
      return;
    }

    const innerType = ty.params[0];

    parts.slice(0, parts.length - 1).forEach((part) => {
      this.bindPattern(part, innerType, false);
    });

    if (parts.length > 0) {
      this.bindPattern(parts[parts.length - 1], isCons ? ty : innerType, false);
    }
  }

  private bindRecordPattern(
    pattern: ERecordPattern,
    type: Type,
    isParameter: boolean,
  ): void {
    const fields = pattern.patternList;

    const ty = this.bindIfVar(pattern, type, TMutableRecord({}, TVar("a")));

    const vars = this.uniqueVars(fields.length);
    if (ty.nodeType === "MutableRecord") {
      fields.forEach((field, i) => {
        const existing = ty.fields[field.text];

        if (!existing) {
          ty.fields[field.text] = vars[i];
        }
      });
    } else if (
      ty.nodeType !== "Record" ||
      fields.some((field) => !Object.keys(ty.fields).includes(field.text))
    ) {
      if (ty.nodeType !== "Unknown") {
        const actualTyParams = Object.fromEntries(
          fields.map((field, i) => [field.text, vars[i]] as [string, Type]),
        );
        const actualTy = TRecord(actualTyParams);
        const recordDiff: RecordDiff | undefined =
          ty.nodeType === "Record"
            ? {
                ...this.calculateRecordDiff(actualTy, ty),
                missing: new Map<string, Type>(),
              }
            : undefined;

        this.diagnostics.push(
          typeMismatchError(
            this.program.getTypeChecker(),
            pattern,
            actualTy,
            ty,
            undefined,
            true,
            recordDiff,
          ),
        );

        if (recordDiff) {
          this.recordDiffs.set(pattern, recordDiff);
        }
      }

      fields.forEach((field) => {
        this.bindPattern(field, TUnknown, isParameter);
      });

      this.expressionTypes.set(pattern, type);
      return;
    }

    const tyFields = (ty as TMutableRecord)?.fields ?? (ty as TRecord).fields;
    fields.forEach((field) => {
      this.bindPattern(field, tyFields[field.text], isParameter);
    });

    this.expressionTypes.set(pattern, type);
  }

  private isAssignable(
    expr: Expression,
    type1: Type,
    type2: Type,
    endExpr?: Expression,
    patternBinding = false,
  ): boolean {
    if (!type1 || !type2) {
      throw new Error("Undefined type error");
    }

    let assignable: boolean;

    if (
      expr.nodeType === "CaseOfExpr" &&
      (!endExpr || endExpr.id === expr.id)
    ) {
      return this.isBranchesAssignable(expr, type1, type2);
    }

    try {
      assignable = this.assignable(type1, type2);
    } catch (error) {
      this.diagnostics.push(
        errorWithEndNode(expr, Diagnostics.General, endExpr, error.message),
      );
      return false;
    }

    if (!assignable) {
      const t1 = TypeReplacement.replace(type1, this.replacements.toMap());
      const t2 = TypeReplacement.replace(type2, this.replacements.toMap());

      const diff =
        t1.nodeType === "Record" && t2.nodeType === "Record"
          ? this.calculateRecordDiff(t1, t2)
          : undefined;

      const errorExpr = expr.nodeType === "LetInExpr" ? expr.body : expr;
      this.diagnostics.push(
        typeMismatchError(
          this.program.getTypeChecker(),
          errorExpr,
          t1,
          t2,
          errorExpr,
          patternBinding,
          diff,
        ),
      );

      if (diff && expr.nodeType === "RecordExpr") {
        this.recordDiffs.set(expr, diff);
      }
    }

    return assignable;
  }

  private isBranchesAssignable(
    expr: ECaseOfExpr,
    type1: Type,
    type2: Type,
  ): boolean {
    // If type2 is not a concrete type, then every branch should match the first type
    const t2 =
      type2.nodeType !== "Unknown" && type2.nodeType !== "Var" ? type2 : type1;

    return expr.branches.every((branch) => {
      const t1 = this.expressionTypes.get(branch.expr);
      return t1 ? this.isAssignable(branch.expr, t1, t2) : false;
    });
  }

  private assignable(type1: Type, type2: Type): boolean {
    const ty1 = this.replacements.get(type1);
    const ty2 = this.replacements.get(type2);

    let result =
      ty1 === ty2 || ty1?.nodeType === "Unknown" || ty2?.nodeType === "Unknown";

    if (!result) {
      if (ty1?.nodeType !== "Var" && ty2?.nodeType === "Var") {
        result = this.nonVarAssignableToVar(ty1, ty2);
      } else {
        switch (ty1?.nodeType) {
          case "Var":
            if (ty2?.nodeType === "Var") {
              result = this.varsAssignable(ty1, ty2);
            } else {
              result = this.nonVarAssignableToVar(ty2, ty1);
            }
            break;
          case "Union":
            {
              result =
                ty2?.nodeType === "Union" &&
                ty1.name === ty2.name &&
                ty1.module === ty2.module &&
                this.allAssignable(ty1.params, ty2.params);
            }
            break;
          case "Function":
            {
              result =
                ty2?.nodeType === "Function" &&
                this.functionAssignable(ty1, ty2);
            }
            break;
          case "Tuple":
            {
              result =
                ty2?.nodeType === "Tuple" &&
                ty1.types.length === ty2.types.length &&
                this.allAssignable(ty1.types, ty2.types);
            }
            break;
          case "Record":
            {
              result =
                (ty2?.nodeType === "Record" &&
                  this.recordAssignable(ty1, ty2)) ||
                (ty2?.nodeType === "MutableRecord" &&
                  this.mutableRecordAssignable(ty2, ty1));
            }
            break;
          case "MutableRecord":
            {
              result =
                (ty2?.nodeType === "Record" &&
                  this.mutableRecordAssignable(ty1, ty2)) ||
                (ty2?.nodeType === "MutableRecord" &&
                  this.mutableRecordAssignable(
                    ty1,
                    mutableRecordAsRecord(ty2),
                  ));
            }
            break;
          case "Unit":
            result = ty2?.nodeType === "Unit";
            break;
          case "Unknown":
            result = true;
            break;
          case "InProgressBinding":
            throw new Error(
              `Should never try to assign an in progress binding`,
            );
        }
      }
    }

    if (ty1 && ty2 && result) {
      this.trackReplacement(ty1, ty2);
    }
    return result;
  }

  private mutableRecordAssignable(
    type1: TMutableRecord,
    type2: TRecord,
  ): boolean {
    if (!this.recordAssignable(mutableRecordAsRecord(type1), type2)) {
      return false;
    }

    type1.fields = { ...type1.fields, ...type2.fields };
    return true;
  }

  private recordAssignable(type1: TRecord, type2: TRecord): boolean {
    const result = this.calculateRecordDiff(type1, type2).isEmpty;
    if (result) {
      if (!type1.baseType && type2.baseType?.nodeType === "Var") {
        this.trackReplacement(type1, type2.baseType);
      }
      if (!type2.baseType && type1.baseType?.nodeType === "Var") {
        this.trackReplacement(type1.baseType, type2);
      }

      type1.fieldReferences.addAll(type2.fieldReferences);
      type2.fieldReferences.addAll(type1.fieldReferences);
    }

    return result;
  }

  private calculateRecordDiff(
    actual: TRecord | TMutableRecord,
    expected: TRecord | TMutableRecord,
  ): RecordDiff {
    const actualEntries = Object.entries(actual.fields);
    const actualKeys = Object.keys(actual.fields);
    const expectedEntries = Object.entries(expected.fields);
    const expectedKeys = Object.keys(expected.fields);

    return RecordDiff(
      expected.baseType
        ? new Map<string, Type>()
        : new Map(
            actualEntries.filter(([field]) => !expectedKeys.includes(field)),
          ),
      actual.baseType
        ? new Map()
        : new Map(
            expectedEntries.filter(([field]) => !actualKeys.includes(field)),
          ),
      new Map(
        actualEntries
          .map(([k, v]) => {
            if (expected.fields[k] && !this.assignable(v, expected.fields[k])) {
              return [k, [v, expected.fields[k]]] as [string, [Type, Type]];
            }

            return undefined;
          })
          .filter(Utils.notUndefined),
      ),
    );
  }

  private allAssignable(type1: Type[], type2: Type[]): boolean {
    return (
      type1.length === type2.length &&
      type1.every((t, i) => this.assignable(t, type2[i]))
    );
  }

  private functionAssignable(type1: TFunction, type2: TFunction): boolean {
    const allTypes1 = type1.params.concat(type1.return);
    const allTypes2 = type2.params.concat(type2.return);

    // If there is only one type, return it
    // If there are multiple, curry it into a new function
    function makeFunction(types: Type[]): Type {
      if (types.length === 1) {
        return types[0];
      } else {
        return TFunction(
          types.slice(0, types.length - 1),
          types[types.length - 1],
        );
      }
    }

    const paramsSize = Math.min(allTypes1.length, allTypes2.length) - 1;

    // Make sure the shared parameters are assignable
    const sharedAssignable = this.allAssignable(
      allTypes1.slice(0, paramsSize),
      allTypes2.slice(0, paramsSize),
    );

    const tailAssignable = this.assignable(
      makeFunction(allTypes1.slice(paramsSize)),
      makeFunction(allTypes2.slice(paramsSize)),
    );

    return sharedAssignable && tailAssignable;
  }

  /**
   * Check that two type vars can be unified
   */
  private varsAssignable(type1: TVar, type2: TVar): boolean {
    const typeClass1 = getTypeclassName(type1);
    const typeClass2 = getTypeclassName(type2);

    if (!type1.rigid && !typeClass1) {
      return true;
    } else if (!type1.rigid && typeClass1) {
      return (
        this.typeclassesCompatible(typeClass1, typeClass2, !type2.rigid) ||
        (!type2.rigid &&
          this.typeclassesConstrainToCompappend(typeClass1, typeClass2))
      );
    } else if (type1.rigid && !typeClass1) {
      return !type2.rigid && !typeClass2;
    } else if (type1.rigid && typeClass1 && type2.rigid) {
      // If they are both rigid and we have a type class, they must be the same typeclass
      return typeClass1 === typeClass2;
    } else if (type1.rigid && typeClass1 && !type2.rigid) {
      return this.typeclassesCompatible(typeClass1, typeClass2, !type2.rigid);
    } else {
      throw new Error("Impossible");
    }
  }

  private nonVarAssignableToVar(
    type: Type | undefined,
    typeVar: TVar,
  ): boolean {
    const allAssignableTo = (types: Type[], typeClass: string): boolean => {
      return types.every((t) => this.assignable(t, TVar(typeClass)));
    };

    if (typeVar.name.startsWith("number")) {
      return (
        type?.nodeType === "Union" && (typeIsFloat(type) || typeIsInt(type))
      );
    } else if (typeVar.name.startsWith("appendable")) {
      return (
        type?.nodeType === "Union" && (typeIsString(type) || typeIsList(type))
      );
    } else if (typeVar.name.startsWith("comparable")) {
      if (type?.nodeType === "Tuple") {
        return allAssignableTo(type.types, "comparable");
      } else if (type?.nodeType === "Union") {
        return (
          typeIsFloat(type) ||
          typeIsInt(type) ||
          typeIsChar(type) ||
          typeIsString(type) ||
          (typeIsList(type) &&
            (allAssignableTo(type.params, "comparable") ||
              allAssignableTo(type.params, "number")))
        );
      } else {
        return false;
      }
    } else if (typeVar.name.startsWith("compappend")) {
      return (
        type?.nodeType === "Union" &&
        (typeIsString(type) ||
          (typeIsList(type) &&
            (allAssignableTo(type.params, "comparable") ||
              allAssignableTo(type.params, "compappend"))))
      );
    }

    return !typeVar.rigid;
  }

  private typeclassesCompatible(
    name1: string,
    name2?: string,
    unconstrainedAllowed = true,
  ): boolean {
    if (!name2) {
      return unconstrainedAllowed;
    }
    if (name1 === name2) {
      return true;
    }
    if (name1 === "number" && name2 === "comparable") {
      return true;
    }
    if (name1 === "comparable" && name2 === "number") {
      return true;
    }
    if (
      name1 === "comparable" &&
      (name2 === "number" || name2 === "compappend")
    ) {
      return true;
    }
    if (
      name1 === "compappend" &&
      (name2 === "comparable" || name2 === "appendable")
    ) {
      return true;
    }
    return false;
  }

  private typeclassesConstrainToCompappend(
    tc1?: string,
    tc2?: string,
  ): boolean {
    if (tc1 === "comparable") {
      return tc2 === "appendable" || tc2 === "compappend";
    }
    if (tc1 === "appendable") {
      return tc2 === "comparable" || tc2 === "compappend";
    }
    return false;
  }

  private trackReplacement(type1: Type, type2: Type): void {
    if (type1 === type2) {
      return;
    }

    // Assign k to be of type v
    const assign = (typeVar: TVar, type: Type): void => {
      if (anyTypeVar(type, (tVar) => tVar === typeVar)) {
        throw Error("InfiniteTypeException");
      }
      this.replacements.set(typeVar, type);
    };

    // If we assign anything to a var, the type is constrained to that var
    if (
      type2.nodeType === "Var" &&
      (!this.replacements.contains(type2) ||
        (type1.nodeType !== "Var" &&
          this.replacements.get(type2)?.nodeType === "Var"))
    ) {
      if (type1.nodeType === "Var") {
        const typeClass1 = getTypeclassName(type1);
        const typeClass2 = getTypeclassName(type2);

        if (!typeClass1 && typeClass2) {
          // Assigning a => number, a should be constrained to number
          assign(type1, type2);
        } else if (
          !type1.rigid &&
          !type2.rigid &&
          this.typeclassesConstrainToCompappend(typeClass1, typeClass2)
        ) {
          assign(
            type1,
            typeClass2 === "compappend" ? type2 : TVar("compappend"),
          );
        } else if (
          !type1.rigid &&
          !type2.rigid &&
          typeClass1 === "comparable" &&
          typeClass2 === "number"
        ) {
          // comparable is constrained to number
          assign(type1, type2);
        } else if (!type1.rigid && type2.rigid) {
          // Assigning a flex var to a rigid var makes it rigid
          assign(type1, type2);
        } else {
          assign(type2, type1);
        }
      } else {
        // Int => number contrains number to be an Int
        assign(type2, type1);
      }
    }

    // Assigning a var to a non var type constrains the type
    if (
      type1.nodeType === "Var" &&
      type2.nodeType !== "Var" &&
      !this.replacements.contains(type1)
    ) {
      if (type2.nodeType === "Record" && type2.baseType) {
        assign(
          type1,
          TMutableRecord(Object.assign({}, type2.fields), type2.baseType),
        );
      } else {
        assign(type1, type2);
      }
    }
  }

  private bindIfVar(e: Expression, type: Type, defaultType: Type): Type {
    if (type.nodeType === "Var") {
      this.isAssignable(e, type, defaultType, undefined, true);
      return defaultType;
    } else {
      return type;
    }
  }

  private uniqueVars(count: number): TVar[] {
    return getVarNames(count).map((val) => {
      return TVar(val);
    });
  }
}

type BindingType = "Annotated" | "Unannotated" | "Other";
interface ParameterBindingResult {
  bindingType: BindingType;
  count: number;
}

interface Annotated extends ParameterBindingResult {
  bindingType: "Annotated";
  type: Type;
}
interface Unannotated extends ParameterBindingResult {
  bindingType: "Unannotated";
  params: Type[];
}
interface Other extends ParameterBindingResult {
  bindingType: "Other";
}
