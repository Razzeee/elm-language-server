import { SyntaxNode } from "web-tree-sitter";
import { IForest } from "../forest";
import { IImports } from "../imports";
import { IReferenceNode } from "./referenceNode";
import { TreeUtils } from "./treeUtils";

export class References {
  public static find(
    definitionNode: IReferenceNode | undefined,
    forest: IForest,
    imports: IImports,
  ): { node: SyntaxNode; uri: string }[] {
    const references: { node: SyntaxNode; uri: string }[] = [];

    if (definitionNode) {
      const refSourceTree = forest.getByUri(definitionNode.uri);

      if (refSourceTree) {
        const moduleNameNode = TreeUtils.getModuleNameNode(refSourceTree.tree);
        switch (definitionNode.nodeType) {
          case "Function":
            const annotationNameNode = this.getFunctionAnnotationNameNodeFromDefinition(
              definitionNode.node,
            );
            if (annotationNameNode && refSourceTree.writeable) {
              references.push({
                node: annotationNameNode,
                uri: definitionNode.uri,
              });
            }

            const functionNameNode = TreeUtils.getFunctionNameNodeFromDefinition(
              definitionNode.node,
            );
            if (functionNameNode) {
              if (refSourceTree.writeable) {
                references.push({
                  node: functionNameNode,
                  uri: definitionNode.uri,
                });
              }

              const localFunctions =
                definitionNode.node.parent &&
                definitionNode.node.parent.type === "let" &&
                definitionNode.node.parent.nextNamedSibling
                  ? this.findFunctionCalls(
                      definitionNode.node.parent.nextNamedSibling,
                      functionNameNode.text,
                    )
                  : this.findFunctionCalls(
                      refSourceTree.tree.rootNode,
                      functionNameNode.text,
                    );

              if (localFunctions && refSourceTree.writeable) {
                references.push(
                  ...localFunctions.map((node) => {
                    return { node, uri: definitionNode.uri };
                  }),
                );
              }

              if (
                TreeUtils.isExposedFunction(
                  refSourceTree.tree,
                  functionNameNode.text,
                )
              ) {
                const moduleDeclarationNode = TreeUtils.findModuleDeclaration(
                  refSourceTree.tree,
                );
                if (moduleDeclarationNode) {
                  const exposedNode = TreeUtils.findExposedFunctionNode(
                    moduleDeclarationNode,
                    functionNameNode.text,
                  );

                  if (exposedNode && refSourceTree.writeable) {
                    references.push({
                      node: exposedNode,
                      uri: definitionNode.uri,
                    });
                  }
                }

                if (moduleNameNode) {
                  for (const uri in imports.imports) {
                    if (imports.imports.hasOwnProperty(uri)) {
                      const element = imports.imports[uri];
                      const needsToBeChecked = element.filter(
                        (a) =>
                          uri !== definitionNode.uri &&
                          a.fromModuleName === moduleNameNode.text &&
                          a.type === "Function" &&
                          (a.alias.endsWith(`.${functionNameNode.text}`) ||
                            a.alias === functionNameNode.text),
                      );
                      if (needsToBeChecked.length > 0) {
                        const treeToCheck = forest.getByUri(uri);

                        if (treeToCheck && treeToCheck.writeable) {
                          const importClauseNode = TreeUtils.findImportClauseByName(
                            treeToCheck.tree,
                            moduleNameNode.text,
                          );
                          if (importClauseNode) {
                            const exposedNode = TreeUtils.findExposedFunctionNode(
                              importClauseNode,
                              functionNameNode.text,
                            );

                            if (exposedNode) {
                              references.push({
                                node: exposedNode,
                                uri,
                              });
                            }
                          }

                          needsToBeChecked.forEach((a) => {
                            const functions = this.findFunctionCalls(
                              treeToCheck.tree.rootNode,
                              a.alias,
                            );
                            if (functions) {
                              references.push(
                                ...functions.map((node) => {
                                  return { node, uri };
                                }),
                              );
                            }
                          });
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
            const typeOrTypeAliasNameNode = TreeUtils.getTypeOrTypeAliasNameNodeFromDefinition(
              definitionNode.node,
            );

            if (typeOrTypeAliasNameNode) {
              if (refSourceTree.writeable) {
                references.push({
                  node: typeOrTypeAliasNameNode,
                  uri: definitionNode.uri,
                });
              }

              const localFunctions = TreeUtils.findTypeOrTypeAliasCalls(
                refSourceTree.tree,
                typeOrTypeAliasNameNode.text,
              );
              if (localFunctions && refSourceTree.writeable) {
                references.push(
                  ...localFunctions.map((node) => {
                    return { node, uri: definitionNode.uri };
                  }),
                );
              }

              if (
                TreeUtils.isExposedTypeOrTypeAlias(
                  refSourceTree.tree,
                  typeOrTypeAliasNameNode.text,
                )
              ) {
                const moduleDeclarationNode = TreeUtils.findModuleDeclaration(
                  refSourceTree.tree,
                );
                if (moduleDeclarationNode) {
                  const exposedNode = TreeUtils.findExposedTypeOrTypeAliasNode(
                    moduleDeclarationNode,
                    typeOrTypeAliasNameNode.text,
                  );

                  if (exposedNode && refSourceTree.writeable) {
                    references.push({
                      node: exposedNode,
                      uri: definitionNode.uri,
                    });
                  }
                }

                if (moduleNameNode) {
                  for (const uri in imports.imports) {
                    if (imports.imports.hasOwnProperty(uri)) {
                      const element = imports.imports[uri];
                      const needsToBeChecked = element.filter(
                        (a) =>
                          uri !== definitionNode.uri &&
                          a.fromModuleName === moduleNameNode.text &&
                          (a.type === "Type" || a.type === "TypeAlias") &&
                          (a.alias.endsWith(
                            `.${typeOrTypeAliasNameNode.text}`,
                          ) ||
                            a.alias === typeOrTypeAliasNameNode.text),
                      );
                      if (needsToBeChecked.length > 0) {
                        const treeToCheck = forest.getByUri(uri);

                        if (treeToCheck && treeToCheck.writeable) {
                          const importClauseNode = TreeUtils.findImportClauseByName(
                            treeToCheck.tree,
                            moduleNameNode.text,
                          );
                          if (importClauseNode) {
                            const exposedNode = TreeUtils.findExposedTypeOrTypeAliasNode(
                              importClauseNode,
                              typeOrTypeAliasNameNode.text,
                            );

                            if (exposedNode) {
                              references.push({
                                node: exposedNode,
                                uri,
                              });
                            }
                          }

                          needsToBeChecked.forEach((a) => {
                            const typeOrTypeAliasCalls = TreeUtils.findTypeOrTypeAliasCalls(
                              treeToCheck.tree,
                              a.alias,
                            );
                            if (typeOrTypeAliasCalls) {
                              references.push(
                                ...typeOrTypeAliasCalls.map((node) => {
                                  return { node, uri };
                                }),
                              );
                            }
                          });
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
                  uri: definitionNode.uri,
                });
              }

              for (const uri in imports.imports) {
                if (imports.imports.hasOwnProperty(uri)) {
                  const element = imports.imports[uri];
                  const needsToBeChecked = element.filter(
                    (a) =>
                      uri !== definitionNode.uri &&
                      a.fromModuleName === moduleNameNode.text,
                  );
                  if (needsToBeChecked.length > 0) {
                    const treeToCheck = forest.getByUri(uri);

                    if (treeToCheck && treeToCheck.writeable) {
                      needsToBeChecked.forEach((a) => {
                        const importNameNode = TreeUtils.findImportNameNode(
                          treeToCheck.tree,
                          a.alias,
                        );
                        if (importNameNode) {
                          references.push({ node: importNameNode, uri });
                        }
                      });
                    }
                  }
                }
              }
            }
            break;

          case "FunctionParameter":
            if (refSourceTree.writeable) {
              references.push({
                node: definitionNode.node,
                uri: definitionNode.uri,
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
                        return { node, uri: definitionNode.uri };
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
                uri: definitionNode.uri,
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
                        return { node, uri: definitionNode.uri };
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
                uri: definitionNode.uri,
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
                        return { node, uri: definitionNode.uri };
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
                  uri: definitionNode.uri,
                });
                const unionConstructorCalls = TreeUtils.findUnionConstructorCalls(
                  refSourceTree.tree,
                  nameNode.text,
                );

                if (unionConstructorCalls) {
                  references.push(
                    ...unionConstructorCalls.map((a) => {
                      return { node: a, uri: definitionNode.uri };
                    }),
                  );
                }
              }

              for (const uri in imports.imports) {
                if (imports.imports.hasOwnProperty(uri)) {
                  const element = imports.imports[uri];
                  const needsToBeChecked = element.filter(
                    (a) =>
                      uri !== definitionNode.uri &&
                      a.fromModuleName === moduleNameNode.text &&
                      a.type === "UnionConstructor" &&
                      (a.alias.endsWith(`.${nameNode.text}`) ||
                        a.alias === nameNode.text),
                  );
                  if (needsToBeChecked.length > 0) {
                    const treeToCheck = forest.getByUri(uri);
                    if (treeToCheck && treeToCheck.writeable) {
                      const unionConstructorCallsFromOtherFiles = TreeUtils.findUnionConstructorCalls(
                        treeToCheck.tree,
                        nameNode.text,
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
            }
            break;

          default:
            break;
        }
      }
    }
    return references;
  }

  public static findOperatorInfixDeclaration(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    const functionNameNode = TreeUtils.getFunctionNameNodeFromDefinition(node);

    if (functionNameNode) {
      const infixRef = this.findFunctionCalls(
        node.tree.rootNode,
        functionNameNode.text,
      )?.find(
        (ref) => ref.parent?.parent?.parent?.type === "infix_declaration",
      );

      if (infixRef?.parent?.parent?.parent) {
        return infixRef.parent.parent.parent;
      }
    }
  }

  private static findFunctionCalls(
    node: SyntaxNode,
    functionName: string,
  ): SyntaxNode[] | undefined {
    const functions = this.findAllFunctionCallsAndParameters(node);
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

  private static getFunctionAnnotationNameNodeFromDefinition(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    if (
      node.previousNamedSibling &&
      node.previousNamedSibling.type === "type_annotation" &&
      node.previousNamedSibling.firstChild &&
      node.previousNamedSibling.firstChild.type === "lower_case_identifier"
    ) {
      return node.previousNamedSibling.firstChild;
    }
  }
}
