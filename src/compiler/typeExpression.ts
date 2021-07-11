import {
  Type,
  TVar,
  uncurryFunction,
  InferenceResult,
  TUnit,
  TUnknown,
  TFunction,
  TTuple,
  TUnion,
  TList,
  TRecord,
  Alias,
} from "./typeInference";
import {
  Expression,
  ETypeExpression,
  ETypeDeclaration,
  ETypeRef,
  ETypeVariable,
  mapSyntaxNodeToExpression,
  ETypeAnnotation,
  findDefinition,
  EUnionVariant,
  ERecordType,
  ETypeAliasDeclaration,
  EPortAnnotation,
  mapTypeDeclaration,
  mapTypeAliasDeclaration,
  mapTypeAnnotation,
} from "./utils/expressionTree";
import { TreeUtils } from "../util/treeUtils";
import { TypeReplacement } from "./typeReplacement";
import { SyntaxNodeMap } from "./utils/syntaxNodeMap";
import { Utils } from "../util/utils";
import { RecordFieldReferenceTable } from "./utils/recordFieldReferenceTable";
import { IProgram } from "./program";
import { Diagnostic, Diagnostics, error } from "./diagnostics";

export class TypeExpression {
  // All the type variables we've seen
  private varsByExpression: SyntaxNodeMap<Expression, TVar> = new SyntaxNodeMap<
    Expression,
    TVar
  >();

  private expressionTypes: SyntaxNodeMap<Expression, Type> = new SyntaxNodeMap<
    Expression,
    Type
  >();

  private diagnostics: Diagnostic[] = [];

  constructor(
    private root: Expression,
    private program: IProgram,
    private rigidVars: boolean,
    private activeAliases: Set<ETypeAliasDeclaration> = new Set(),
  ) {}

  public static typeDeclarationInference(
    e: ETypeDeclaration,
    program: IProgram,
  ): InferenceResult {
    const setter = (): InferenceResult => {
      mapTypeDeclaration(e); // Fill in values only when needed
      const inferenceResult = new TypeExpression(
        e,
        program,
        /* rigidVars */ false,
      ).inferTypeDeclaration(e);

      TypeReplacement.freeze(inferenceResult.type);

      return {
        ...inferenceResult,
        type: TypeReplacement.freshenVars(inferenceResult.type),
      };
    };

    if (!program.getForest().getByUri(e.tree.uri)?.writeable) {
      return program
        .getTypeCache()
        .getOrSet("PACKAGE_TYPE_AND_TYPE_ALIAS", e, setter);
    } else {
      return program
        .getTypeCache()
        .getOrSet("PROJECT_TYPE_AND_TYPE_ALIAS", e, setter);
    }
  }

  public static typeAliasDeclarationInference(
    e: ETypeAliasDeclaration,
    program: IProgram,
    activeAliases = new Set<ETypeAliasDeclaration>(),
  ): InferenceResult {
    const setter = (): InferenceResult => {
      mapTypeAliasDeclaration(e);
      const inferenceResult = new TypeExpression(
        e,
        program,
        /* rigidVars */ false,
        activeAliases,
      ).inferTypeAliasDeclaration(e);

      TypeReplacement.freeze(inferenceResult.type);

      return {
        ...inferenceResult,
        type: TypeReplacement.freshenVars(inferenceResult.type),
      };
    };

    if (!program.getForest().getByUri(e.tree.uri)?.writeable) {
      return program
        .getTypeCache()
        .getOrSet("PACKAGE_TYPE_AND_TYPE_ALIAS", e, setter);
    } else {
      return program
        .getTypeCache()
        .getOrSet("PROJECT_TYPE_AND_TYPE_ALIAS", e, setter);
    }
  }

  public static typeAnnotationInference(
    e: ETypeAnnotation,
    program: IProgram,
    rigid = true,
  ): InferenceResult | undefined {
    const setter = (): InferenceResult => {
      mapTypeAnnotation(e);
      const inferenceResult = new TypeExpression(
        e,
        program,
        /* rigidVars */ true,
      ).inferTypeExpression(e.typeExpression!);

      const type = TypeReplacement.replace(inferenceResult.type, new Map());
      TypeReplacement.freeze(inferenceResult.type);

      program.getTypeCache().trackTypeAnnotation(e);

      return { ...inferenceResult, type };
    };

    const result = !program.getForest().getByUri(e.tree.uri)?.writeable
      ? program.getTypeCache().getOrSet("PACKAGE_TYPE_ANNOTATION", e, setter)
      : program.getTypeCache().getOrSet("PROJECT_TYPE_ANNOTATION", e, setter);

    if (!rigid) {
      result.type = TypeReplacement.flexify(result.type);
    }

    return result;
  }

  public static unionVariantInference(
    e: EUnionVariant,
    program: IProgram,
  ): InferenceResult {
    const inferenceResult = new TypeExpression(
      e,
      program,
      /* rigidVars */ false,
    ).inferUnionConstructor(e);
    TypeReplacement.freeze(inferenceResult.type);

    return {
      ...inferenceResult,
      type: TypeReplacement.freshenVars(inferenceResult.type),
    };
  }

  public static portAnnotationInference(
    e: EPortAnnotation,
    program: IProgram,
  ): InferenceResult {
    const inferenceResult = new TypeExpression(
      e,
      program,
      /* rigidVars */ false,
    ).inferPortAnnotation(e);
    TypeReplacement.freeze(inferenceResult.type);

    return {
      ...inferenceResult,
      type: TypeReplacement.freshenVars(inferenceResult.type),
    };
  }

  private inferTypeDeclaration(
    typeDeclaration: ETypeDeclaration,
  ): InferenceResult {
    return this.toResult(this.typeDeclarationType(typeDeclaration));
  }

  private inferTypeExpression(typeExpr: ETypeExpression): InferenceResult {
    return this.toResult(this.typeExpressionType(typeExpr));
  }

  private inferUnionConstructor(unionVariant: EUnionVariant): InferenceResult {
    const declaration = mapSyntaxNodeToExpression(
      TreeUtils.findParentOfType("type_declaration", unionVariant),
    );
    mapTypeDeclaration(declaration as ETypeDeclaration);

    const declarationType: Type =
      declaration && declaration.nodeType === "TypeDeclaration"
        ? this.typeDeclarationType(declaration)
        : TUnknown;

    const params = unionVariant.params.map((t) =>
      this.typeSignatureSegmentType(t),
    );

    const type: Type =
      params.length > 0 ? TFunction(params, declarationType) : declarationType;

    return this.toResult(type);
  }

  private inferPortAnnotation(
    portAnnotation: EPortAnnotation,
  ): InferenceResult {
    const type = this.typeExpressionType
      ? this.typeExpressionType(portAnnotation.typeExpression)
      : TUnknown;
    return this.toResult(type);
  }

  private inferTypeAliasDeclaration(
    declaration: ETypeAliasDeclaration,
  ): InferenceResult {
    this.activeAliases.add(declaration);

    const type = declaration.typeExpression
      ? this.typeExpressionType(declaration.typeExpression)
      : TUnknown;

    const params = declaration.typeVariables.map(this.getTypeVar.bind(this));
    const moduleName =
      TreeUtils.getModuleNameNode(declaration.tree)?.text ?? "";
    const alias: Alias = {
      module: moduleName,
      name: declaration.name.text,
      parameters: params,
    };
    return this.toResult({ ...type, alias: alias });
  }

  private typeExpressionType(typeExpr: ETypeExpression): Type {
    const segmentTypes = typeExpr.segments.map((s) =>
      this.typeSignatureSegmentType(s),
    );
    const type =
      segmentTypes.length === 1
        ? segmentTypes[0]
        : uncurryFunction(
            TFunction(
              segmentTypes.slice(0, segmentTypes.length - 1),
              segmentTypes[segmentTypes.length - 1],
            ),
          );

    this.expressionTypes.set(typeExpr, type);

    return type;
  }

  private toResult(type: Type): InferenceResult {
    return {
      type,
      expressionTypes: this.expressionTypes,
      diagnostics: this.diagnostics,
      recordDiffs: new SyntaxNodeMap(),
    };
  }

  private typeSignatureSegmentType(segment: Expression): Type {
    let type: Type = TUnknown;

    switch (segment.nodeType) {
      case "TypeRef":
        type = this.typeRefType(segment);
        break;
      case "TypeVariable":
        type = this.typeVariableType(segment);
        break;
      case "TypeExpression":
        type = this.typeExpressionType(segment);
        break;
      case "TupleType":
        type = segment.unitExpr
          ? TUnit
          : TTuple(
              segment.typeExpressions.map((t) => this.typeExpressionType(t)),
            );
        break;
      case "RecordType":
        type = this.recordTypeDeclarationType(segment);
        break;
    }

    return type;
  }

  private typeVariableType(typeVariable: ETypeVariable): Type {
    const definition = findDefinition(
      typeVariable.firstNamedChild,
      this.program,
    );

    // The type variable doesn't reference anything
    if (!definition.expr || definition.expr.id === typeVariable.id) {
      const type = this.getTypeVar(typeVariable);
      this.expressionTypes.set(typeVariable, type);
      return type;
    }

    const cached = this.varsByExpression.get(definition.expr);

    if (cached) {
      return cached;
    }

    const annotation = mapSyntaxNodeToExpression(
      TreeUtils.findParentOfType("type_annotation", definition.expr),
    );

    if (annotation) {
      mapTypeAnnotation(annotation as ETypeAnnotation);
    }

    const expr = annotation
      ? annotation.childForFieldName("typeExpression")
      : undefined;

    // If the definition is not in a type annotation or it is to a
    // variable in the same annotation, use the type of the reference
    if (!annotation || !expr || annotation.id === this.root.id) {
      const type = this.getTypeVar(definition.expr);
      this.varsByExpression.set(typeVariable, type);
      this.expressionTypes.set(typeVariable, type);
      return type;
    }

    // If the definition is to a variable declared in a parent annotation,
    // use the type from that annotation's inference
    const type =
      TypeExpression.typeAnnotationInference(
        annotation as ETypeAnnotation,
        this.program,
        /* rigid */ true,
      )?.expressionTypes.get(definition.expr) ?? TUnknown;

    if (type.nodeType === "Var") {
      this.varsByExpression.set(definition.expr, type);
    }

    this.expressionTypes.set(typeVariable, type);
    return type;
  }

  private recordTypeDeclarationType(record: ERecordType): TRecord {
    const fieldExpressions = record.fieldTypes;
    if (!fieldExpressions || fieldExpressions.length === 0) {
      return TRecord({});
    }

    const fieldTypes: { [key: string]: Type } = {};
    fieldExpressions.forEach((field) => {
      fieldTypes[field.name] = this.typeExpressionType(field.typeExpression);
    });

    const fieldRefs =
      RecordFieldReferenceTable.fromExpressions(fieldExpressions);

    const baseTypeDefinition = findDefinition(
      record.baseType,
      this.program,
    )?.expr;

    const baseType = baseTypeDefinition
      ? this.getTypeVar(baseTypeDefinition)
      : record.baseType
      ? TVar(record.baseType.text)
      : undefined;

    const type = TRecord(fieldTypes, baseType, undefined, fieldRefs);

    this.expressionTypes.set(record, type);
    return type;
  }

  private typeRefType(typeRef: ETypeRef): Type {
    const args =
      TreeUtils.findAllNamedChildrenOfType(
        [
          "type_variable",
          "type_ref",
          "tuple_type",
          "record_type",
          "type_expression",
        ],
        typeRef,
      )
        ?.map(mapSyntaxNodeToExpression)
        .filter(Utils.notUndefined)
        .map((arg) => this.typeSignatureSegmentType(arg)) ?? [];

    const definition = findDefinition(
      typeRef.firstNamedChild?.lastNamedChild,
      this.program,
    );

    this.diagnostics.push(...definition.diagnostics);

    let declaredType: Type = TUnknown;
    if (definition.expr) {
      switch (definition.expr.nodeType) {
        case "TypeDeclaration":
          declaredType = TypeExpression.typeDeclarationInference(
            definition.expr,
            this.program,
          ).type;
          break;
        case "TypeAliasDeclaration":
          {
            // Check for recursion
            const aliases = Array.from(this.activeAliases);
            const recursiveAlias = aliases.find(
              (decl) => decl.id === definition.expr?.id,
            );
            if (recursiveAlias) {
              const name = definition.expr.childForFieldName("name");
              const index = aliases.findIndex(
                (alias) => alias.id === recursiveAlias.id,
              );
              if (name) {
                const slicedAliases = aliases.slice(index);
                this.diagnostics.push(
                  error(
                    name,
                    Diagnostics.RecursiveAlias(slicedAliases.length),
                    ...slicedAliases.map(
                      (alias) => alias.childForFieldName("name")?.text ?? "",
                    ),
                  ),
                );
              }
              declaredType = TUnknown;
            } else {
              declaredType = TypeExpression.typeAliasDeclarationInference(
                definition.expr,
                this.program,
                new Set(this.activeAliases.values()),
              ).type;
            }
          }
          break;
        default:
          throw new Error("Unexpected type reference");
      }
    } else {
      if (typeRef.firstNamedChild?.firstNamedChild?.text === "List") {
        declaredType = TList(TVar("a"));
      } else if (
        typeRef.firstNamedChild &&
        definition.diagnostics.length === 0
      ) {
        this.diagnostics.push(
          error(
            typeRef.firstNamedChild,
            Diagnostics.MissingValue,
            typeRef.firstNamedChild.text,
          ),
        );
      }
    }

    const params = declaredType?.alias
      ? declaredType.alias.parameters
      : declaredType?.nodeType === "Union"
      ? declaredType.params
      : [];

    if (declaredType.nodeType !== "Unknown" && params.length !== args.length) {
      this.diagnostics.push(
        error(
          typeRef,
          Diagnostics.TypeArgumentCount,
          params.length,
          args.length,
        ),
      );
      return TUnknown;
    }

    if (params.length === 0) {
      return declaredType;
    }

    // The param types are always TVars
    return TypeReplacement.replace(
      declaredType,
      new Map(
        params
          .map<[TVar, Type]>((p, i) => [<TVar>p, args[i]])
          .filter(([, type]) => !!type),
      ),
    );
  }

  private typeDeclarationType(typeDeclaration: ETypeDeclaration): Type {
    const params: TVar[] = typeDeclaration.typeNames.map((name) =>
      this.getTypeVar(name),
    );

    return TUnion(
      this.program.getForest().getByUri(typeDeclaration.tree.uri)?.moduleName ??
        "",
      typeDeclaration.name,
      params,
    );
  }

  private getTypeVar(e: Expression): TVar {
    return this.varsByExpression.getOrSet(e, () =>
      TVar(e.text, this.rigidVars),
    );
  }
}
