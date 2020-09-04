import { container } from "tsyringe";
import {
  IConnection,
  Location,
  Position,
  Range,
  ReferenceParams,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { Tree } from "tree-sitter-elm";
import { IElmWorkspace } from "../elmWorkspace";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { References } from "../util/references";
import { TreeUtils } from "../util/treeUtils";

type ReferenceResult = Location[] | null | undefined;

export class ReferencesProvider {
  private connection: IConnection;
  constructor() {
    this.connection = container.resolve<IConnection>("Connection");
    this.connection.onReferences(
      new ElmWorkspaceMatcher((param: ReferenceParams) =>
        URI.parse(param.textDocument.uri),
      ).handlerForWorkspace(this.handleReferencesRequest),
    );
  }

  protected handleReferencesRequest = (
    params: ReferenceParams,
    elmWorkspace: IElmWorkspace,
  ): ReferenceResult => {
    this.connection.console.info(`References were requested`);

    const imports = elmWorkspace.getImports();
    const forest = elmWorkspace.getForest();

    const tree: Tree | undefined = forest.getTree(params.textDocument.uri);

    if (tree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.position,
      );

      const definitionNode = TreeUtils.findDefinitionNodeByReferencingNode(
        nodeAtPosition,
        params.textDocument.uri,
        tree,
        imports,
      );

      const references = References.find(definitionNode, forest, imports);

      if (references) {
        return references.map((a) =>
          Location.create(
            a.uri,
            Range.create(
              Position.create(
                a.node.startPosition.row,
                a.node.startPosition.column,
              ),
              Position.create(
                a.node.endPosition.row,
                a.node.endPosition.column,
              ),
            ),
          ),
        );
      }
    }

    return undefined;
  };
}
