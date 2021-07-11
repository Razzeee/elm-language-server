import { container } from "tsyringe";
import {
  Connection,
  CreateFilesParams,
  DeleteFilesParams,
  FileCreate,
  FileDelete,
  FileRename,
  RenameFilesParams,
  WorkspaceEdit,
} from "vscode-languageserver";
import { TextEdit } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { IProgram } from "../../compiler/program";
import { PositionUtil } from "../../positionUtil";
import { getModuleName } from "../../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { RefactorEditUtils } from "../../util/refactorEditUtils";
import { RenameUtils } from "../../util/renameUtils";
import { TreeUtils } from "../../util/treeUtils";
import { ASTProvider } from "../astProvider";
import {
  ICreateFileParams,
  IDeleteFileParams,
  IRenameFileParams,
} from "../paramsExtensions";
import { RenameProvider } from "../renameProvider";

export class FileEventsHandler {
  private connection: Connection;
  private astProvider: ASTProvider;

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
    this.astProvider = container.resolve(ASTProvider);

    this.connection.workspace.onDidCreateFiles((params: CreateFilesParams) => {
      const edit: WorkspaceEdit = { changes: {} };
      for (const { uri } of params.files) {
        const changes = new ElmWorkspaceMatcher(({ uri }: FileCreate) =>
          URI.parse(uri),
        ).handle(this.onDidCreateFile.bind(this))({
          uri,
        });

        if (changes && edit.changes) {
          edit.changes[uri] = changes;
        }
      }

      void this.connection.workspace.applyEdit(edit);
    });

    this.connection.workspace.onWillRenameFiles((params: RenameFilesParams) => {
      const edit: WorkspaceEdit = { changes: {} };
      for (const { oldUri, newUri } of params.files) {
        const workspaceEdit = new ElmWorkspaceMatcher(
          ({ oldUri }: FileRename) => URI.parse(oldUri),
        ).handle(this.onWillRenameFile.bind(this))({
          oldUri,
          newUri,
        });

        if (workspaceEdit) {
          this.mergeWorkspaceEdit(edit, workspaceEdit);
        }
      }
      return edit;
    });

    this.connection.workspace.onWillDeleteFiles((params: DeleteFilesParams) => {
      for (const { uri } of params.files) {
        new ElmWorkspaceMatcher(({ uri }: FileDelete) => URI.parse(uri)).handle(
          this.onWillDeleteFile.bind(this),
        )({
          uri,
        });
      }

      return null;
    });
  }

  private onDidCreateFile({
    uri,
    program,
  }: ICreateFileParams): TextEdit[] | undefined {
    const moduleName = this.getModuleNameFromFile(uri, program);

    if (moduleName) {
      const addModuleDefinitionEdit =
        RefactorEditUtils.addModuleDeclaration(moduleName);
      return [addModuleDefinitionEdit];
    }
  }

  private onWillRenameFile({
    oldUri,
    newUri,
    program,
    sourceFile,
  }: IRenameFileParams): WorkspaceEdit | undefined {
    // Handle folder rename
    if (!sourceFile) {
      return Array.from(program.getForest().treeMap.values())
        .filter(({ uri }) => uri.startsWith(`${oldUri}/`))
        .map((sourceFile) =>
          this.onWillRenameFile({
            oldUri: sourceFile.uri,
            newUri: sourceFile.uri.replace(oldUri, newUri),
            program,
            sourceFile,
          }),
        )
        .reduce<WorkspaceEdit>(
          (prev, cur) => (cur ? this.mergeWorkspaceEdit(prev, cur) : prev),
          {},
        );
    }

    const newModuleName = this.getModuleNameFromFile(newUri, program);
    const moduleNameNode = TreeUtils.getModuleNameNode(sourceFile.tree);

    if (newModuleName && moduleNameNode) {
      const moduleNodePosition = PositionUtil.FROM_TS_POSITION(
        moduleNameNode.endPosition,
      ).toVSPosition();

      const affectedNodes = RenameUtils.getRenameAffectedNodes(
        program,
        oldUri,
        moduleNodePosition,
      );

      const [edits] = RenameProvider.getRenameEdits(
        affectedNodes,
        newModuleName,
      );

      if (sourceFile.moduleName) {
        if (!sourceFile.isTestFile) {
          sourceFile.project.moduleToUriMap.delete(sourceFile.moduleName);
          sourceFile.project.moduleToUriMap.set(newModuleName, newUri);
        }

        sourceFile.project.testModuleToUriMap.delete(sourceFile.moduleName);
        sourceFile.project.testModuleToUriMap.set(newModuleName, newUri);
      }

      this.astProvider.addPendingRename(oldUri, newUri);

      return {
        changes: edits,
      };
    }
  }

  private onWillDeleteFile({ uri, program }: IDeleteFileParams): void {
    program.getForest().removeTree(uri);
  }

  private getModuleNameFromFile(
    uri: string,
    program: IProgram,
  ): string | undefined {
    const sourceDir = program.getSourceDirectoryOfFile(URI.parse(uri).fsPath);

    // The file is not in a source dir (shouldn't happen)
    if (!sourceDir) {
      return;
    }

    return getModuleName(uri, URI.file(sourceDir).toString());
  }

  private mergeWorkspaceEdit(
    a: WorkspaceEdit,
    b: WorkspaceEdit,
  ): WorkspaceEdit {
    // Merge changes
    if (b.changes) {
      Object.entries(b.changes).forEach(([uri, edits]) => {
        if (!a.changes) {
          a.changes = {};
        }

        if (a.changes[uri]) {
          a.changes[uri].push(...edits);
        } else {
          a.changes[uri] = edits;
        }
      });
    }

    if (b.documentChanges) {
      if (!a.documentChanges) {
        a.documentChanges = [];
      }
      a.documentChanges.push(...b.documentChanges);
    }

    return a;
  }
}
