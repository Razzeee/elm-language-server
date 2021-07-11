import { container } from "tsyringe";
import { Connection, Position, Range, TextEdit } from "vscode-languageserver";
import { URI } from "vscode-uri";
import {
  GetMoveDestinationRequest,
  IMoveDestination,
  IMoveDestinationsResponse,
  IMoveParams,
  MoveRequest,
} from "../../protocol";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { RefactorEditUtils } from "../../util/refactorEditUtils";
import { References } from "../../compiler/references";
import { TreeUtils } from "../../util/treeUtils";

export class MoveRefactoringHandler {
  private connection: Connection;

  constructor() {
    this.connection = container.resolve("Connection");
    this.connection.onRequest(
      GetMoveDestinationRequest,
      new ElmWorkspaceMatcher((param: IMoveParams) =>
        URI.parse(param.sourceUri),
      ).handle(this.handleGetMoveDestinationsRequest.bind(this)),
    );

    this.connection.onRequest(
      MoveRequest,
      new ElmWorkspaceMatcher((param: IMoveParams) =>
        URI.parse(param.sourceUri),
      ).handle(this.handleMoveRequest.bind(this)),
    );
  }

  private handleGetMoveDestinationsRequest(
    params: IMoveParams,
  ): IMoveDestinationsResponse {
    const forest = params.program.getForest();

    const destinations: IMoveDestination[] = Array.from(forest.treeMap.values())
      .filter((tree) => tree.writeable && tree.uri !== params.sourceUri)
      .map((tree) => {
        let uri = URI.parse(tree.uri).fsPath;
        const rootPath = params.program.getRootPath().fsPath;

        uri = uri.slice(rootPath.length + 1);
        const index = uri.lastIndexOf("\\");

        return {
          name: uri.slice(index + 1),
          path: uri.slice(0, index),
          uri: tree.uri,
        };
      });

    return {
      destinations,
    };
  }

  private async handleMoveRequest(params: IMoveParams): Promise<void> {
    if (!params.destination) {
      return;
    }

    const forest = params.program.getForest();
    const tree = forest.getTree(params.sourceUri);
    const destinationTree = forest.getTree(params.destination.uri);

    if (tree && destinationTree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.params.range.start,
      );

      const isTypeNode = nodeAtPosition.parent?.type === "type_annotation";
      const isDeclarationNode =
        nodeAtPosition.parent?.parent?.type === "value_declaration";

      const typeNode = isDeclarationNode
        ? nodeAtPosition.parent?.parent?.previousNamedSibling?.type ===
          "type_annotation"
          ? nodeAtPosition.parent?.parent?.previousNamedSibling
          : undefined
        : isTypeNode
        ? nodeAtPosition.parent
        : undefined;

      const declarationNode = isDeclarationNode
        ? nodeAtPosition.parent?.parent
        : isTypeNode
        ? nodeAtPosition.parent?.nextNamedSibling
        : undefined;

      const commentNode =
        typeNode?.previousNamedSibling?.type === "block_comment"
          ? typeNode.previousNamedSibling
          : declarationNode?.previousNamedSibling?.type === "block_comment"
          ? declarationNode.previousNamedSibling
          : undefined;

      const functionName = nodeAtPosition.text;

      const moduleName = TreeUtils.getModuleNameNode(tree)?.text;

      const destinationModuleName =
        TreeUtils.getModuleNameNode(destinationTree)?.text;

      if (
        declarationNode &&
        functionName &&
        moduleName &&
        destinationModuleName
      ) {
        const startPosition =
          commentNode?.startPosition ??
          typeNode?.startPosition ??
          declarationNode.startPosition;
        const endPosition = declarationNode.endPosition;

        const comment = commentNode ? `${commentNode.text}\n` : "";
        const type = typeNode ? `${typeNode.text}\n` : "";

        const functionText = `\n\n${comment}${type}${declarationNode.text}`;

        const changes: { [uri: string]: TextEdit[] } = {};

        changes[params.sourceUri] = [];
        changes[params.destination.uri] = [];

        // Remove from source
        changes[params.sourceUri].push(
          TextEdit.del(
            Range.create(
              Position.create(startPosition.row, startPosition.column),
              Position.create(endPosition.row, endPosition.column),
            ),
          ),
        );

        // Add to destination
        changes[params.destination.uri].push(
          TextEdit.insert(
            Position.create(destinationTree.rootNode.endPosition.row + 1, 0),
            functionText,
          ),
        );

        // Update references
        const references = References.find(
          {
            name: declarationNode.text,
            node: declarationNode,
            type: "Function",
          },
          params.program,
        ).map((ref) => {
          return {
            ...ref,
            fullyQualified: TreeUtils.isReferenceFullyQualified(ref.node),
          };
        });

        const sourceHasReference = !!references.find(
          (ref) =>
            ref.uri === params.sourceUri &&
            ref.node.parent?.text !== typeNode?.text &&
            ref.node.parent?.parent?.text !== declarationNode?.text &&
            ref.node.type !== "exposed_value",
        );

        const referenceUris = new Set(references.map((ref) => ref.uri));

        // Unexpose function in the source file if it is
        const unexposeEdit = RefactorEditUtils.unexposedValueInModule(
          tree,
          functionName,
        );
        if (unexposeEdit) {
          changes[params.sourceUri].push(unexposeEdit);
        }

        // Remove old imports to the old source file from all reference uris
        referenceUris.forEach((refUri) => {
          if (!changes[refUri]) {
            changes[refUri] = [];
          }

          const refTree = forest.getTree(refUri);

          if (refTree && params.destination?.name) {
            const removeImportEdit = RefactorEditUtils.removeValueFromImport(
              refTree,
              moduleName,
              functionName,
            );

            if (removeImportEdit) {
              changes[refUri].push(removeImportEdit);
            }
          }
        });

        // Expose function in destination file if there are external references
        if (
          references.filter(
            (ref) => ref.uri !== params.destination?.uri && !ref.fullyQualified,
          ).length > 0
        ) {
          const exposeEdit = RefactorEditUtils.exposeValueInModule(
            destinationTree,
            functionName,
          );

          if (exposeEdit) {
            changes[params.destination.uri].push(exposeEdit);
          }
        }

        // Change the module name of every reference that is fully qualified
        references.forEach((ref) => {
          if (ref.fullyQualified) {
            if (ref.uri !== params.destination?.uri) {
              const edit = RefactorEditUtils.changeQualifiedReferenceModule(
                ref.node,
                destinationModuleName,
              );

              if (edit) {
                changes[ref.uri].push(edit);
              }
            } else {
              // Remove the qualified references altogether on the destination file
              const edit = RefactorEditUtils.removeQualifiedReference(ref.node);

              if (edit) {
                changes[ref.uri].push(edit);
              }
            }
          }
        });

        // We don't want the destination file in the remaining edits
        referenceUris.delete(params.destination.uri);

        // Add the new imports for each file with a reference
        referenceUris.forEach((refUri) => {
          if (refUri === params.sourceUri && !sourceHasReference) {
            return;
          }

          const needToExpose = references
            .filter((ref) => ref.uri === refUri)
            .some((ref) => !ref.fullyQualified);

          const refTree = forest.getTree(refUri);

          if (refTree) {
            const importEdit = RefactorEditUtils.addImport(
              refTree,
              destinationModuleName,
              needToExpose ? functionName : undefined,
            );

            if (importEdit) {
              changes[refUri].push(importEdit);
            }
          }
        });

        await this.connection.workspace.applyEdit({ changes });
      }
    }
  }
}
