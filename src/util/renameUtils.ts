import { IProgram } from "../compiler/program";
import { Position, ResponseError } from "vscode-languageserver";
import { SyntaxNode } from "web-tree-sitter";
import { References } from "../compiler/references";
import { TreeUtils } from "./treeUtils";

export class RenameUtils {
  static getRenameAffectedNodes(
    program: IProgram,
    uri: string,
    position: Position,
  ):
    | {
        originalNode: SyntaxNode;
        references: {
          node: SyntaxNode;
          uri: string;
        }[];
      }
    | undefined {
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(uri);

    if (sourceFile) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        position,
      );

      const definitionNode = checker.findDefinition(
        nodeAtPosition,
        sourceFile,
      ).symbol;

      if (definitionNode) {
        const refTree = program.getSourceFile(definitionNode.node.tree.uri);
        if (refTree && refTree.writeable) {
          return {
            originalNode: nodeAtPosition,
            references: References.find(definitionNode, program),
          };
        }
        if (refTree && !refTree.writeable) {
          throw new ResponseError(
            1,
            "Can not rename, due to source being outside of you project.",
          );
        }
      }
    }
  }
}
