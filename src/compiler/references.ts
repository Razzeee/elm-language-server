import { IProgram } from "./program";
import { ISourceFile } from "./forest";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { TreeUtils } from "../util/treeUtils";
import { Utils } from "../util/utils";
import { Imports } from "./imports";
import { ISymbol } from "./binder";

export class References {
  public static find(
    definitionNode: ISymbol | undefined,
    program: IProgram,
  ): { node: SyntaxNode; uri: string }[] {
    const references: { node: SyntaxNode; uri: string }[] = [];

    const forest = program.getForest();
    const checker = program.getTypeChecker();

    if (definitionNode) {
      const refSourceTree = forest.getByUri(definitionNode.node.tree.uri);

      if (refSourceTree) {
        const imports: { [uri: string]: Imports } = {};
        forest.treeMap.forEach((sourceFile) => {
          imports[sourceFile.uri] = checker.getAllImports(sourceFile);
        });

        const moduleNameNode = TreeUtils.getModuleNameNode(refSourceTree.tree);
        switch (definitionNode.type) {
          case "Function":
            {
              if (definitionNode.node.parent) {
                const annotationNameNode = TreeUtils.getTypeAnnotation(
                  definitionNode.node.parent,
                )?.childForFieldName("name");

                if (annotationNameNode && refSourceTree.writeable) {
                  references.push({
                    node: annotationNameNode,
                    uri: definitionNode.node.tree.uri,
                  });
                }
              }

              const functionNameNode =
                TreeUtils.getFunctionNameNodeFromDefinition(
                  definitionNode.node,
                ) ??
                (definitionNode.node.type === "lower_pattern"
                  ? definitionNode.node
                  : undefined);
              if (functionNameNode) {
                const functionName = functionNameNode.text;
                if (refSourceTree.writeable) {
                  references.push({
                    node: functionNameNode,
                    uri: definitionNode.node.tree.uri,
                  });
                }

                const letParent = TreeUtils.findParentOfType(
                  "let_in_expr",
                  definitionNode.node,
                );
                const localFunctions = letParent
                  ? this.findFunctionCalls(letParent, functionName)
                  : this.findFunctionCalls(
                      refSourceTree.tree.rootNode,
                      functionName,
                    );

                if (localFunctions && refSourceTree.writeable) {
                  references.push(
                    ...localFunctions.map((node) => {
                      return { node, uri: definitionNode.node.tree.uri };
                    }),
                  );
                }

                const isExposedFunction = TreeUtils.isExposedFunctionOrPort(
                  refSourceTree.tree,
                  functionName,
                );
                if (isExposedFunction && !letParent) {
                  const moduleDeclarationNode = TreeUtils.findModuleDeclaration(
                    refSourceTree.tree,
                  );
                  if (moduleDeclarationNode) {
                    const exposedNode = TreeUtils.findExposedFunctionNode(
                      moduleDeclarationNode,
                      functionName,
                    );

                    if (exposedNode && refSourceTree.writeable) {
                      references.push({
                        node: exposedNode,
                        uri: definitionNode.node.tree.uri,
                      });
                    }
                  }

                  if (isExposedFunction && moduleNameNode) {
                    const moduleName = moduleNameNode.text;

                    for (const uri in imports) {
                      if (uri === definitionNode.node.tree.uri) {
                        continue;
                      }

                      const otherSourceFile = forest.getByUri(uri);

                      if (!otherSourceFile) {
                        continue;
                      }

                      const importedModuleAlias =
                        TreeUtils.findImportAliasOfModule(
                          moduleName,
                          otherSourceFile.tree,
                        ) ?? moduleName;

                      const allImports = imports[uri];

                      // Find the function in the other module's imports
                      const found = [
                        ...allImports.getVar(functionName, moduleName),
                        ...allImports.getVar(
                          `${importedModuleAlias}.${functionName}`,
                          moduleName,
                        ),
                      ];

                      if (found.length > 0 && otherSourceFile.writeable) {
                        const importClause = otherSourceFile.symbolLinks
                          ?.get(otherSourceFile.tree.rootNode)
                          ?.get(importedModuleAlias);

                        // Add node from exposing list
                        if (importClause?.type === "Import") {
                          const exposedNode = TreeUtils.findExposedFunctionNode(
                            importClause.node,
                            functionName,
                          );

                          if (exposedNode) {
                            references.push({
                              node: exposedNode,
                              uri,
                            });
                          }
                        }

                        // Find all function calls in the other tree
                        const functions = found.flatMap(
                          (imp) =>
                            this.findFunctionCalls(
                              otherSourceFile.tree.rootNode,
                              imp.name,
                            ) ?? [],
                        );
                        if (functions.length > 0) {
                          references.push(
                            ...functions.map((node) => {
                              return { node, uri };
                            }),
                          );
                        }
                      }
                    }
                  }
                }
              }
            }

            break;
          case "Port":
            {
              const portNameNode =
                TreeUtils.getTypeOrTypeAliasOrPortNameNodeFromDefinition(
                  definitionNode.node,
                );
              if (portNameNode) {
                const portName = portNameNode.text;
                if (refSourceTree.writeable) {
                  references.push({
                    node: portNameNode,
                    uri: definitionNode.node.tree.uri,
                  });
                }

                const localCallsToPort = this.findFunctionCalls(
                  refSourceTree.tree.rootNode,
                  portName,
                );

                if (localCallsToPort && refSourceTree.writeable) {
                  references.push(
                    ...localCallsToPort.map((node) => {
                      return { node, uri: definitionNode.node.tree.uri };
                    }),
                  );
                }

                const isExposedPort = TreeUtils.isExposedFunctionOrPort(
                  refSourceTree.tree,
                  portName,
                );
                if (isExposedPort) {
                  const moduleDeclarationNode = TreeUtils.findModuleDeclaration(
                    refSourceTree.tree,
                  );
                  if (moduleDeclarationNode) {
                    const exposedNode = TreeUtils.findExposedFunctionNode(
                      moduleDeclarationNode,
                      portName,
                    );

                    if (exposedNode && refSourceTree.writeable) {
                      references.push({
                        node: exposedNode,
                        uri: definitionNode.node.tree.uri,
                      });
                    }
                  }

                  if (isExposedPort && moduleNameNode) {
                    const moduleName = moduleNameNode.text;

                    for (const uri in imports) {
                      if (uri === definitionNode.node.tree.uri) {
                        continue;
                      }

                      const otherSourceFile = forest.getByUri(uri);

                      if (!otherSourceFile) {
                        continue;
                      }

                      const importedModuleAlias =
                        TreeUtils.findImportAliasOfModule(
                          moduleName,
                          otherSourceFile.tree,
                        ) ?? moduleName;

                      const allImports = imports[uri];

                      // Find the function in the other module's imports
                      const found = [
                        ...allImports.getVar(portName, moduleName),
                        ...allImports.getVar(
                          `${importedModuleAlias}.${portName}`,
                          moduleName,
                        ),
                      ];

                      if (found.length > 0 && otherSourceFile.writeable) {
                        const importClause = otherSourceFile.symbolLinks
                          ?.get(otherSourceFile.tree.rootNode)
                          ?.get(importedModuleAlias);

                        // Add node from exposing list
                        if (importClause?.type === "Import") {
                          const exposedNode = TreeUtils.findExposedFunctionNode(
                            importClause.node,
                            portName,
                          );

                          if (exposedNode) {
                            references.push({
                              node: exposedNode,
                              uri,
                            });
                          }
                        }

                        // Find all function calls in the other tree
                        const functions = found.flatMap(
                          (imp) =>
                            this.findFunctionCalls(
                              otherSourceFile.tree.rootNode,
                              imp.name,
                            ) ?? [],
                        );
                        if (functions.length > 0) {
                          references.push(
                            ...functions.map((node) => {
                              return { node, uri };
                            }),
                          );
                        }
                      }
                    }
                  }
                }
              }
            }

            break;
          case "Type":
          case "TypeAlias":
            {
              const typeOrTypeAliasNameNode =
                TreeUtils.getTypeOrTypeAliasOrPortNameNodeFromDefinition(
                  definitionNode.node,
                );

              if (typeOrTypeAliasNameNode) {
                const typeOrTypeAliasName = typeOrTypeAliasNameNode.text;
                if (refSourceTree.writeable) {
                  references.push({
                    node: typeOrTypeAliasNameNode,
                    uri: definitionNode.node.tree.uri,
                  });
                }

                const localFunctions = TreeUtils.findTypeOrTypeAliasCalls(
                  refSourceTree.tree,
                  typeOrTypeAliasName,
                );
                if (localFunctions && refSourceTree.writeable) {
                  references.push(
                    ...localFunctions.map((node) => {
                      return { node, uri: definitionNode.node.tree.uri };
                    }),
                  );
                }

                const isExposed = TreeUtils.isExposedTypeOrTypeAlias(
                  refSourceTree.tree,
                  typeOrTypeAliasName,
                );
                if (isExposed) {
                  const moduleDeclarationNode = TreeUtils.findModuleDeclaration(
                    refSourceTree.tree,
                  );
                  if (moduleDeclarationNode) {
                    const exposedNode =
                      TreeUtils.findExposedTypeOrTypeAliasNode(
                        moduleDeclarationNode,
                        typeOrTypeAliasName,
                      );

                    if (exposedNode && refSourceTree.writeable) {
                      references.push({
                        node: exposedNode,
                        uri: definitionNode.node.tree.uri,
                      });
                    }
                  }

                  if (isExposed && moduleNameNode) {
                    const moduleName = moduleNameNode.text;
                    for (const uri in imports) {
                      if (uri === definitionNode.node.tree.uri) {
                        continue;
                      }

                      const otherSourceFile = forest.getByUri(uri);

                      if (!otherSourceFile) {
                        continue;
                      }

                      const importedModuleAlias =
                        TreeUtils.findImportAliasOfModule(
                          moduleName,
                          otherSourceFile.tree,
                        ) ?? moduleName;

                      const allImports = imports[uri];

                      // Find the type or type alias in the other module's imports
                      const found = [
                        ...allImports.getType(typeOrTypeAliasName, moduleName),
                        ...allImports.getType(
                          `${importedModuleAlias}.${typeOrTypeAliasName}`,
                          moduleName,
                        ),
                      ];

                      if (found.length > 0 && otherSourceFile.writeable) {
                        const importClause = otherSourceFile.symbolLinks
                          ?.get(otherSourceFile.tree.rootNode)
                          ?.get(importedModuleAlias);

                        if (importClause?.type === "Import") {
                          const exposedNode =
                            TreeUtils.findExposedTypeOrTypeAliasNode(
                              importClause.node,
                              typeOrTypeAliasNameNode.text,
                            );

                          if (exposedNode) {
                            references.push({
                              node: exposedNode,
                              uri,
                            });
                          }
                        }

                        const typeOrTypeAliasCalls = found.flatMap(
                          (imp) =>
                            TreeUtils.findTypeOrTypeAliasCalls(
                              otherSourceFile.tree,
                              imp.name,
                            ) ?? [],
                        );
                        if (typeOrTypeAliasCalls.length > 0) {
                          references.push(
                            ...typeOrTypeAliasCalls.map((node) => {
                              return { node, uri };
                            }),
                          );
                        }
                      }
                    }
                  }
                }
              }
            }

            break;

          case "Module":
            if (moduleNameNode) {
              if (refSourceTree.writeable) {
                references.push({
                  node: moduleNameNode,
                  uri: definitionNode.node.tree.uri,
                });
              }

              for (const uri in imports) {
                if (uri === definitionNode.node.tree.uri) {
                  continue;
                }

                const sourceFileToCheck = forest.getByUri(uri);

                if (!sourceFileToCheck || !sourceFileToCheck.writeable) {
                  continue;
                }

                const moduleNameToLookFor =
                  TreeUtils.findImportAliasOfModule(
                    moduleNameNode.text,
                    sourceFileToCheck.tree,
                  ) ?? moduleNameNode.text;

                // Check if it is imported
                const imported = sourceFileToCheck.symbolLinks
                  ?.get(sourceFileToCheck.tree.rootNode)
                  ?.get(
                    moduleNameToLookFor,
                    (symbol) => symbol.type === "Import",
                  );

                if (imported) {
                  const importNameNode = checker.findImportModuleNameNodes(
                    moduleNameToLookFor,
                    sourceFileToCheck,
                  )[0];

                  if (importNameNode) {
                    references.push({ node: importNameNode, uri });
                  }
                }

                // If it is not imported as an alias, find all references in file
                if (imported && moduleNameToLookFor === moduleNameNode.text) {
                  sourceFileToCheck.tree.rootNode
                    .descendantsOfType("value_expr")
                    .forEach((valueNode) => {
                      if (
                        RegExp(`${moduleNameToLookFor}.[a-z].*`).exec(
                          valueNode.text,
                        )
                      ) {
                        references.push({ node: valueNode, uri });
                      }
                    });
                }
              }
            }
            break;

          case "FunctionParameter":
            if (refSourceTree.writeable) {
              references.push({
                node: definitionNode.node,
                uri: definitionNode.node.tree.uri,
              });

              const valueDeclaration = TreeUtils.findParentOfType(
                "function_declaration_left",
                definitionNode.node,
              );
              if (
                valueDeclaration &&
                valueDeclaration.nextNamedSibling &&
                valueDeclaration.nextNamedSibling.nextNamedSibling
              ) {
                const functionBody =
                  valueDeclaration.nextNamedSibling.nextNamedSibling;
                if (functionBody) {
                  const parameters = this.findParameterUsage(
                    functionBody,
                    definitionNode.node.text,
                  );
                  if (parameters) {
                    references.push(
                      ...parameters.map((node) => {
                        return { node, uri: definitionNode.node.tree.uri };
                      }),
                    );
                  }
                }
              }
            }
            break;

          case "CasePattern":
            if (refSourceTree.writeable) {
              references.push({
                node: definitionNode.node,
                uri: definitionNode.node.tree.uri,
              });

              if (
                definitionNode.node.parent &&
                definitionNode.node.parent.parent &&
                definitionNode.node.parent.parent.parent &&
                definitionNode.node.parent.parent.parent.lastNamedChild
              ) {
                const caseBody =
                  definitionNode.node.parent.parent.parent.lastNamedChild;
                if (caseBody) {
                  const parameters = this.findParameterUsage(
                    caseBody,
                    definitionNode.node.text,
                  );
                  if (parameters) {
                    references.push(
                      ...parameters.map((node) => {
                        return { node, uri: definitionNode.node.tree.uri };
                      }),
                    );
                  }
                }
              }
            }
            break;

          case "AnonymousFunctionParameter":
            if (refSourceTree.writeable) {
              references.push({
                node: definitionNode.node,
                uri: definitionNode.node.tree.uri,
              });

              if (
                definitionNode.node.parent &&
                definitionNode.node.parent.parent
              ) {
                const anonymousFunction = definitionNode.node.parent.parent; // TODO this is due to tree sitter matching wrong
                if (anonymousFunction) {
                  const parameters = this.findParameterUsage(
                    anonymousFunction,
                    definitionNode.node.text,
                  );
                  if (parameters) {
                    references.push(
                      ...parameters.map((node) => {
                        return { node, uri: definitionNode.node.tree.uri };
                      }),
                    );
                  }
                }
              }
            }
            break;

          case "UnionConstructor":
            if (definitionNode.node.firstChild && moduleNameNode) {
              const nameNode = definitionNode.node.firstChild;
              if (refSourceTree.writeable) {
                references.push({
                  node: nameNode,
                  uri: definitionNode.node.tree.uri,
                });
                const unionConstructorCalls =
                  TreeUtils.findUnionConstructorCalls(
                    refSourceTree.tree,
                    nameNode.text,
                  );

                if (unionConstructorCalls) {
                  references.push(
                    ...unionConstructorCalls.map((a) => {
                      return { node: a, uri: definitionNode.node.tree.uri };
                    }),
                  );
                }
              }

              for (const uri in imports) {
                if (uri === definitionNode.node.tree.uri) {
                  continue;
                }

                const otherSourceFile = program.getSourceFile(uri);

                if (!otherSourceFile) {
                  continue;
                }

                const moduleName = moduleNameNode.text;

                const importedModuleAlias =
                  TreeUtils.findImportAliasOfModule(
                    moduleName,
                    otherSourceFile.tree,
                  ) ?? moduleName;

                const allImports = imports[uri];
                const found =
                  allImports.getConstructor(nameNode.text, moduleName)[0] ??
                  allImports.getConstructor(
                    `${importedModuleAlias}.${nameNode.text}`,
                    moduleName,
                  )[0];

                if (found && found.type === "UnionConstructor") {
                  if (otherSourceFile.writeable) {
                    const unionConstructorCallsFromOtherFiles =
                      TreeUtils.findUnionConstructorCalls(
                        otherSourceFile.tree,
                        nameNode.text,
                        importedModuleAlias,
                      );
                    if (unionConstructorCallsFromOtherFiles) {
                      references.push(
                        ...unionConstructorCallsFromOtherFiles.map((node) => {
                          return { node, uri };
                        }),
                      );
                    }
                  }
                }
              }
            }
            break;

          case "FieldType":
            {
              const fieldName = definitionNode.node.childForFieldName("name");

              if (fieldName) {
                references.push({
                  node: fieldName,
                  uri: definitionNode.node.tree.uri,
                });

                references.push(
                  ...this.getFieldReferences(
                    fieldName.text,
                    definitionNode,
                    refSourceTree,
                    program,
                  ),
                );

                for (const uri in imports) {
                  if (uri === definitionNode.node.tree.uri) {
                    continue;
                  }

                  const needsToBeChecked = forest
                    .getByUri(uri)
                    ?.resolvedModules?.get(moduleNameNode?.text ?? "");

                  if (needsToBeChecked) {
                    const treeToCheck = forest.getByUri(uri);

                    if (treeToCheck && treeToCheck.writeable) {
                      references.push(
                        ...this.getFieldReferences(
                          fieldName.text,
                          definitionNode,
                          treeToCheck,
                          program,
                        ),
                      );
                    }
                  }
                }
              }
            }
            break;

          case "TypeVariable":
            {
              const topLevelAnnotation = TreeUtils.findParentOfType(
                "type_annotation",
                definitionNode.node,
                true,
              );

              const typeVariableNodes: SyntaxNode[] = [];

              if (topLevelAnnotation) {
                const topLevelValueDeclaration =
                  TreeUtils.getValueDeclaration(topLevelAnnotation);

                const typeAnnotations = [
                  topLevelAnnotation,
                  ...(topLevelValueDeclaration?.descendantsOfType(
                    "type_annotation",
                  ) ?? []),
                ];

                typeVariableNodes.push(
                  ...typeAnnotations.flatMap(
                    (typeAnnotation) =>
                      typeAnnotation
                        .childForFieldName("typeExpression")
                        ?.descendantsOfType("type_variable") ?? [],
                  ),
                );
              }

              const topLevelTypeOrTypeAlias =
                TreeUtils.findParentOfType(
                  "type_alias_declaration",
                  definitionNode.node,
                ) ??
                TreeUtils.findParentOfType(
                  "type_declaration",
                  definitionNode.node,
                );

              if (topLevelTypeOrTypeAlias) {
                typeVariableNodes.push(
                  ...topLevelTypeOrTypeAlias.descendantsOfType([
                    "type_variable",
                    "lower_type_name",
                  ]),
                );
              }

              typeVariableNodes
                .filter(
                  (typeVariable) => typeVariable.text === definitionNode.name,
                )
                .forEach((typeVariable) =>
                  references.push({
                    node: typeVariable,
                    uri: typeVariable.tree.uri,
                  }),
                );
            }
            break;

          default:
            break;
        }
      }
    }
    return references;
  }

  public static findOperator(
    node: SyntaxNode,
    program: IProgram,
  ): SyntaxNode | undefined {
    const functionNameNode = TreeUtils.getFunctionNameNodeFromDefinition(node);

    if (functionNameNode) {
      const infixRef = program
        .getForest()
        .getByUri(node.tree.uri)
        ?.symbolLinks?.get(node.tree.rootNode)
        ?.get(
          functionNameNode.text,
          (s) => s.node.type === "infix_declaration",
        );

      return infixRef?.node;
    }
  }

  private static findFunctionCalls(
    node: SyntaxNode,
    functionName: string,
  ): SyntaxNode[] | undefined {
    const functions = [
      ...this.findAllFunctionCallsAndParameters(node).concat(),
      ...node.descendantsOfType("record_base_identifier"),
    ];
    const result = functions
      .filter((a) => a.text === functionName)
      .map((a) => a.lastChild!);
    return result.length === 0 ? undefined : result;
  }

  private static findAllFunctionCallsAndParameters(
    node: SyntaxNode,
  ): SyntaxNode[] {
    let functions = TreeUtils.descendantsOfType(node, "value_expr");
    if (functions.length > 0) {
      functions = functions
        .filter((a) => a.firstChild && a.firstChild.type === "value_qid")
        .map((a) => a.firstChild!);
    }

    return functions;
  }

  private static findParameterUsage(
    node: SyntaxNode,
    functionName: string,
  ): SyntaxNode[] | undefined {
    const parameters: SyntaxNode[] = [
      ...this.findAllFunctionCallsAndParameters(node),
      ...this.findAllRecordBaseIdentifiers(node),
    ];
    const result = parameters.filter((a) => a.text === functionName);
    return result.length === 0 ? undefined : result;
  }

  private static findAllRecordBaseIdentifiers(node: SyntaxNode): SyntaxNode[] {
    return TreeUtils.descendantsOfType(node, "record_base_identifier");
  }

  private static findFieldUsages(tree: Tree, fieldName: string): SyntaxNode[] {
    return tree.rootNode
      .descendantsOfType([
        "field",
        "field_accessor_function_expr",
        "field_access_expr",
        "record_pattern",
      ])
      .flatMap((field) => {
        if (field.type === "record_pattern") {
          const lowerPattern = field.namedChildren.find(
            (pattern) =>
              pattern.type === "lower_pattern" && pattern.text === fieldName,
          );

          if (lowerPattern) {
            const declaration = TreeUtils.findParentOfType(
              "value_declaration",
              lowerPattern,
            );

            const patternRefs =
              declaration
                ?.descendantsOfType("value_qid")
                .filter((ref) => ref.text === fieldName) ?? [];

            return [lowerPattern, ...patternRefs];
          }
        }

        return [field];
      })
      .map((field) =>
        TreeUtils.findFirstNamedChildOfType("lower_case_identifier", field),
      )
      .filter(Utils.notUndefinedOrNull)
      .filter((field) => field.text === fieldName);
  }

  private static getFieldReferences(
    fieldName: string,
    definition: ISymbol,
    sourceFile: ISourceFile,
    program: IProgram,
  ): { node: SyntaxNode; uri: string }[] {
    const references: { node: SyntaxNode; uri: string }[] = [];

    const fieldUsages = References.findFieldUsages(sourceFile.tree, fieldName);

    fieldUsages.forEach((field) => {
      const fieldDef = program
        .getTypeChecker()
        .findDefinition(field, sourceFile).symbol;

      if (fieldDef?.node.id === definition.node.id) {
        references.push({
          node: field,
          uri: sourceFile.uri,
        });
      }
    });

    return references;
  }
}
