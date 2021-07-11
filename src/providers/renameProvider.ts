import { container } from "tsyringe";
import {
  Connection,
  OptionalVersionedTextDocumentIdentifier,
  Position,
  PrepareRenameParams,
  Range,
  RenameFile,
  RenameParams,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode } from "web-tree-sitter";
import { IProgram } from "../compiler/program";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { RenameUtils } from "../util/renameUtils";
import { TreeUtils } from "../util/treeUtils";
import { IRenameParams, IPrepareRenameParams } from "./paramsExtensions";

export class RenameProvider {
  private connection: Connection;

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
    this.connection.onPrepareRename(
      new ElmWorkspaceMatcher((params: PrepareRenameParams) =>
        URI.parse(params.textDocument.uri),
      ).handle(this.handlePrepareRenameRequest.bind(this)),
    );

    this.connection.onRenameRequest(
      new ElmWorkspaceMatcher((params: RenameParams) =>
        URI.parse(params.textDocument.uri),
      ).handle(this.handleRenameRequest.bind(this)),
    );
  }

  protected handleRenameRequest = (
    params: IRenameParams,
  ): WorkspaceEdit | null | undefined => {
    this.connection.console.info(`Renaming was requested`);

    let newName = params.newName;

    const affectedNodes = RenameUtils.getRenameAffectedNodes(
      params.program,
      params.textDocument.uri,
      params.position,
    );

    newName = this.uppercaseNewNameIfModuleDeclaration(newName, affectedNodes);

    const renameChanges: RenameFile[] = [];
    const moduleDeclarationRenameChange =
      this.createModuleDeclarationRenameChange(
        affectedNodes,
        params.program,
        params,
        newName,
      );
    if (moduleDeclarationRenameChange) {
      renameChanges.push(moduleDeclarationRenameChange);
    }

    const [edits, textDocumentEdits] = RenameProvider.getRenameEdits(
      affectedNodes,
      newName,
    );

    return {
      changes: edits, // Fallback if the client doesn't implement documentChanges
      documentChanges: [...textDocumentEdits, ...renameChanges], //Order seems to be important here
    };
  };

  protected handlePrepareRenameRequest = (
    params: IPrepareRenameParams,
  ): Range | null => {
    this.connection.console.info(`Prepare rename was requested`);

    const affectedNodes = RenameUtils.getRenameAffectedNodes(
      params.program,
      params.textDocument.uri,
      params.position,
    );

    if (affectedNodes?.references.length) {
      let node = affectedNodes.originalNode;

      // For a qualified value Component.Test.func, if renamed the module name, select the whole thing
      if (
        node.type === "upper_case_identifier" &&
        node.parent?.type === "value_qid"
      ) {
        const moduleNameNodes =
          TreeUtils.findAllNamedChildrenOfType(
            "upper_case_identifier",
            node.parent,
          ) ?? [];

        const first = moduleNameNodes[0];
        const last = moduleNameNodes[moduleNameNodes.length - 1];

        return Range.create(
          Position.create(first.startPosition.row, first.startPosition.column),
          Position.create(last.endPosition.row, last.endPosition.column),
        );
      }

      // Select the whole module uppercase id `Component.Test` instead of just `Test`
      if (node.parent?.parent?.type === "module_declaration") {
        node = node.parent;
      }

      return Range.create(
        Position.create(node.startPosition.row, node.startPosition.column),
        Position.create(node.endPosition.row, node.endPosition.column),
      );
    }

    return null;
  };

  public static getRenameEdits(
    affectedNodes:
      | {
          originalNode: SyntaxNode;
          references: { node: SyntaxNode; uri: string }[];
        }
      | undefined,
    newName: string,
  ): [{ [uri: string]: TextEdit[] }, TextDocumentEdit[]] {
    const edits: { [uri: string]: TextEdit[] } = {};
    let originalName = affectedNodes?.originalNode.text ?? "";

    // Helps us to rename fully qualified functions without changing the last part
    if (
      affectedNodes?.originalNode.type === "upper_case_identifier" &&
      (affectedNodes.originalNode.parent?.type === "value_qid" ||
        affectedNodes.originalNode.parent?.type === "upper_case_qid")
    ) {
      const moduleNameNodes =
        TreeUtils.findAllNamedChildrenOfType(
          "upper_case_identifier",
          affectedNodes.originalNode.parent,
        ) ?? [];

      originalName = moduleNameNodes.map((node) => node.text).join(".");
    }

    affectedNodes?.references.forEach((a) => {
      if (!edits[a.uri]) {
        edits[a.uri] = [];
      }

      const startColumn =
        a.node.startPosition.column + a.node.text.indexOf(originalName);
      const endColumn = startColumn + originalName.length;

      edits[a.uri].push(
        TextEdit.replace(
          Range.create(
            Position.create(a.node.startPosition.row, startColumn),
            Position.create(a.node.endPosition.row, endColumn),
          ),
          newName,
        ),
      );
    });

    const textDocumentEdits = [];
    for (const key in edits) {
      if (Object.prototype.hasOwnProperty.call(edits, key)) {
        const element = edits[key];
        textDocumentEdits.push(
          TextDocumentEdit.create(
            OptionalVersionedTextDocumentIdentifier.create(key, null),
            element,
          ),
        );
      }
    }

    return [edits, textDocumentEdits];
  }

  private createModuleDeclarationRenameChange(
    affectedNodes:
      | {
          originalNode: SyntaxNode;
          references: {
            node: SyntaxNode;
            uri: string;
          }[];
        }
      | undefined,
    program: IProgram,
    params: RenameParams,
    newName: string,
  ): RenameFile | undefined {
    if (
      affectedNodes?.originalNode.parent?.parent?.type === "module_declaration"
    ) {
      const newUri = this.generateUriFromModuleName(
        newName,
        program,
        params.textDocument.uri,
      );

      if (newUri) {
        return {
          kind: "rename",
          oldUri: params.textDocument.uri,
          newUri: newUri.toString(),
        } as RenameFile;
      }
    }
  }

  uppercaseNewNameIfModuleDeclaration(
    newName: string,
    affectedNodes:
      | {
          originalNode: SyntaxNode;
          references: { node: SyntaxNode; uri: string }[];
        }
      | undefined,
  ): string {
    if (
      affectedNodes?.originalNode.parent?.parent?.type === "module_declaration"
    ) {
      return newName
        .split(".")
        .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
        .join(".");
    } else {
      return newName;
    }
  }

  private generateUriFromModuleName(
    moduleName: string,
    program: IProgram,
    file: string,
  ): URI | undefined {
    const sourceDir = program.getSourceDirectoryOfFile(file);

    // The file is not in a source dir (shouldn't happen)
    if (!sourceDir) {
      return;
    }

    const newUri = `${sourceDir}/${moduleName.replace(/\./g, "/")}.elm`;

    return URI.file(newUri);
  }
}
