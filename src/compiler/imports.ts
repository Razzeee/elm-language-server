import Parser, { SyntaxNode } from "web-tree-sitter";
import { IForest, ISourceFile } from "./forest";
import { TreeUtils } from "../util/treeUtils";
import { container } from "tsyringe";
import { MultiMap } from "../util/multiMap";
import { performance } from "perf_hooks";
import { isCoreProject } from "./utils/elmUtils";
import { Diagnostic, Diagnostics, error } from "./diagnostics";
import { ISymbol } from "./binder";

export let importsTime = 0;
export function resetImportsTime(): void {
  importsTime = 0;
}

type FromModule = {
  name: string;
  uri: string;
  maintainerAndPackageName?: string;
};

export interface IImport extends ISymbol {
  fromModule: FromModule;
}

function importModuleEqual(a: IImport, b: IImport): boolean {
  return (
    a.fromModule.name === b.fromModule.name &&
    a.fromModule.maintainerAndPackageName ===
      b.fromModule.maintainerAndPackageName
  );
}

/**
 * Imports class that extends a map to handle multiple named imports
 */
export class Imports {
  private vars = new MultiMap<string, IImport>();
  private types = new MultiMap<string, IImport>();
  private constructors = new MultiMap<string, IImport>();
  private modules = new Map<string, IImport>();
  private diagnostics: Diagnostic[] = [];

  private getFromMap(
    map: MultiMap<string, IImport>,
    name: string,
    module?: string,
  ): IImport[] {
    const all = map.getAll(name) ?? [];
    return module ? all.filter((imp) => imp.fromModule.name === module) : all;
  }

  public getVar(name: string, module?: string): IImport[] {
    return this.getFromMap(this.vars, name, module);
  }

  public getType(name: string, module?: string): IImport[] {
    return this.getFromMap(this.types, name, module);
  }

  public getConstructor(name: string, module?: string): IImport[] {
    return this.getFromMap(this.constructors, name, module);
  }

  public getModule(name: string): IImport | undefined {
    return this.modules.get(name);
  }

  public forEach(callbackfn: (value: IImport) => void): void {
    this.vars.forEach(callbackfn);
    this.types.forEach(callbackfn);
    this.constructors.forEach((ctor) => {
      // These are already in 'types'
      if (ctor.type !== "TypeAlias") {
        callbackfn(ctor);
      }
    });
  }

  public getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  private static cachedVirtualImports: SyntaxNode[];

  public static getImports(sourceFile: ISourceFile, forest: IForest): Imports {
    const start = performance.now();
    const result = new Imports();

    const importNodes = [
      ...(isCoreProject(sourceFile.project) ? [] : Imports.getVirtualImports()),
      ...(TreeUtils.findAllImportClauseNodes(sourceFile.tree) ?? []),
    ];

    importNodes.forEach((importNode) => {
      const moduleName = importNode.childForFieldName("moduleName")?.text;
      if (moduleName) {
        const uri = sourceFile.resolvedModules?.get(moduleName);

        if (!uri) {
          return;
        }

        const foundModule = forest.getByUri(uri);
        if (foundModule) {
          const fromModule = {
            name: moduleName,
            uri,
            maintainerAndPackageName: foundModule.maintainerAndPackageName,
          };

          const foundModuleNode = TreeUtils.findModuleDeclaration(
            foundModule.tree,
          );
          if (foundModuleNode) {
            result.modules.set(moduleName, {
              name: moduleName,
              node: foundModuleNode,
              type: "Module",
              fromModule,
            });

            const exposedFromRemoteModule = foundModule.exposing;
            if (exposedFromRemoteModule) {
              const importedAs = Imports.findImportAsClause(importNode);
              const importPrefix = importedAs ? importedAs : fromModule.name;

              // Add qualified imports
              // The compiler keeps these separate from normal ones,
              // but I'm not sure that is needed
              exposedFromRemoteModule.forEach((symbol, name) => {
                const qualifiedName = `${importPrefix}.${name}`;
                switch (symbol.type) {
                  case "Function":
                  case "Port":
                    result.vars.set(
                      qualifiedName,
                      {
                        ...symbol,
                        name: qualifiedName,
                        fromModule,
                      },
                      importModuleEqual,
                    );
                    break;

                  case "Type":
                  case "TypeAlias":
                    result.types.set(
                      qualifiedName,
                      {
                        ...symbol,
                        name: qualifiedName,
                        fromModule,
                      },
                      importModuleEqual,
                    );
                    symbol.constructors?.forEach((ctor) => {
                      const qualifiedName = `${importPrefix}.${ctor.name}`;
                      result.constructors.set(
                        qualifiedName,
                        {
                          ...ctor,
                          name: qualifiedName,
                          fromModule,
                        },
                        importModuleEqual,
                      );
                    });
                }
              });

              const exposingList = importNode.childForFieldName("exposing");

              if (exposingList) {
                const doubleDot = exposingList.childForFieldName("doubleDot");
                if (doubleDot) {
                  exposedFromRemoteModule.forEach((exposed) => {
                    switch (exposed.type) {
                      case "Type":
                      case "TypeAlias":
                        result.types.set(
                          exposed.name,
                          {
                            ...exposed,
                            fromModule,
                          },
                          importModuleEqual,
                        );
                        exposed.constructors?.forEach((ctor) => {
                          result.constructors.set(
                            ctor.name,
                            {
                              ...ctor,
                              fromModule,
                            },
                            importModuleEqual,
                          );
                        });

                        break;

                      case "Function":
                      case "Port":
                      case "Operator":
                        result.vars.set(
                          exposed.name,
                          {
                            ...exposed,
                            fromModule,
                          },
                          importModuleEqual,
                        );
                    }
                  });
                } else {
                  const exposedOperators = TreeUtils.descendantsOfType(
                    exposingList,
                    "operator_identifier",
                  );
                  exposedOperators.forEach((exposedOperator) => {
                    const symbol = exposedFromRemoteModule.get(
                      exposedOperator.text,
                    );
                    if (symbol) {
                      result.vars.set(
                        symbol.name,
                        {
                          ...symbol,
                          fromModule,
                        },
                        importModuleEqual,
                      );
                    } else {
                      result.diagnostics.push(
                        error(
                          exposedOperator,
                          Diagnostics.ImportExposingNotFound,
                          fromModule.name,
                          exposedOperator.text,
                        ),
                      );
                    }
                  });

                  const exposedValues = TreeUtils.findAllNamedChildrenOfType(
                    "exposed_value",
                    exposingList,
                  );
                  exposedValues?.forEach((exposedValue) => {
                    const symbol = exposedFromRemoteModule.get(
                      exposedValue.text,
                    );
                    if (symbol) {
                      result.vars.set(
                        symbol.name,
                        {
                          ...symbol,
                          fromModule,
                        },
                        importModuleEqual,
                      );
                    } else {
                      result.diagnostics.push(
                        error(
                          exposedValue,
                          Diagnostics.ImportExposingNotFound,
                          fromModule.name,
                          exposedValue.text,
                        ),
                      );
                    }
                  });

                  const exposedTypes = TreeUtils.findAllNamedChildrenOfType(
                    "exposed_type",
                    exposingList,
                  );

                  exposedTypes?.forEach((exposedType) => {
                    const typeName = TreeUtils.findFirstNamedChildOfType(
                      "upper_case_identifier",
                      exposedType,
                    )?.text;

                    const exposedUnionConstructors =
                      !!TreeUtils.findFirstNamedChildOfType(
                        "exposed_union_constructors",
                        exposedType,
                      );

                    if (typeName) {
                      const symbol = exposedFromRemoteModule.get(typeName);

                      if (exposedUnionConstructors) {
                        if (symbol) {
                          if (symbol.type === "Type") {
                            result.types.replace(symbol.name, {
                              ...symbol,
                              fromModule,
                            });

                            symbol.constructors?.forEach((ctor) => {
                              result.constructors.set(
                                ctor.name,
                                {
                                  ...ctor,
                                  fromModule,
                                },
                                importModuleEqual,
                              );
                            });
                          } else if (symbol.type === "TypeAlias") {
                            result.diagnostics.push(
                              error(
                                exposedType,
                                Diagnostics.ImportOpenAlias,
                                typeName,
                              ),
                            );
                          }
                        } else {
                          result.diagnostics.push(
                            error(
                              exposedType,
                              Diagnostics.ImportExposingNotFound,
                              fromModule.name,
                              typeName,
                            ),
                          );
                        }
                      } else {
                        if (symbol) {
                          if (
                            symbol.type === "Type" ||
                            symbol.type === "TypeAlias"
                          ) {
                            result.types.replace(symbol.name, {
                              ...symbol,
                              fromModule,
                            });
                          }
                          if (symbol.type === "TypeAlias") {
                            symbol.constructors?.forEach((ctor) => {
                              result.constructors.set(
                                ctor.name,
                                {
                                  ...ctor,
                                  fromModule,
                                },
                                importModuleEqual,
                              );
                            });
                          }
                        } else {
                          // The compiler does special checking for an ImportCtorByName error here
                          result.diagnostics.push(
                            error(
                              exposedType,
                              Diagnostics.ImportExposingNotFound,
                              fromModule.name,
                              typeName,
                            ),
                          );
                        }
                      }
                    }
                  });
                }
              }
            }
          }
        }
      }
    });

    importsTime += performance.now() - start;

    return result;
  }

  public static getVirtualImports(): SyntaxNode[] {
    if (this.cachedVirtualImports) {
      return this.cachedVirtualImports;
    }

    const virtualImports = `
  import Basics exposing (..)
  import List exposing (List, (::))
  import Maybe exposing (Maybe(..))
  import Result exposing (Result(..))
  import String exposing (String)
  import Char exposing (Char)
  import Tuple

  import Debug

  import Platform exposing ( Program )
  import Platform.Cmd as Cmd exposing ( Cmd )
  import Platform.Sub as Sub exposing ( Sub )
      `;

    const parser = container.resolve<Parser>("Parser");
    const importTree = parser.parse(virtualImports);

    return (this.cachedVirtualImports = importTree.rootNode.children);
  }

  private static findImportAsClause(
    importNode: SyntaxNode,
  ): string | undefined {
    const asClause = TreeUtils.findFirstNamedChildOfType(
      "as_clause",
      importNode,
    );
    if (asClause) {
      const newName = TreeUtils.findFirstNamedChildOfType(
        "upper_case_identifier",
        asClause,
      );
      if (newName) {
        return newName.text;
      }
    }
  }
}
