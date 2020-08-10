import { readFileSync } from "fs";
import { container } from "tsyringe";
import {
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  IConnection,
  VersionedTextDocumentIdentifier,
  Event,
  Emitter,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import Parser, { Tree, SyntaxNode } from "web-tree-sitter";
import { IElmWorkspace } from "../elmWorkspace";
import { IDocumentEvents } from "../util/documentEvents";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { FileEventsHandler } from "./handlers/fileEventsHandler";

export class ASTProvider {
  private connection: IConnection;
  private parser: Parser;

  private treeChangeEvent = new Emitter<{ uri: string; tree: Tree }>();
  readonly onTreeChange: Event<{ uri: string; tree: Tree }> = this
    .treeChangeEvent.event;

  constructor() {
    this.parser = container.resolve("Parser");
    this.connection = container.resolve<IConnection>("Connection");
    const documentEvents = container.resolve<IDocumentEvents>("DocumentEvents");

    new FileEventsHandler();

    documentEvents.on(
      "change",
      new ElmWorkspaceMatcher((params: DidChangeTextDocumentParams) =>
        URI.parse(params.textDocument.uri),
      ).handlerForWorkspace(this.handleChangeTextDocument),
    );

    documentEvents.on(
      "open",
      new ElmWorkspaceMatcher((params: DidOpenTextDocumentParams) =>
        URI.parse(params.textDocument.uri),
      ).handlerForWorkspace(this.handleChangeTextDocument),
    );
  }

  protected handleChangeTextDocument = (
    params: DidChangeTextDocumentParams | DidOpenTextDocumentParams,
    elmWorkspace: IElmWorkspace,
  ): void => {
    this.connection.console.info(
      `Changed text document, going to parse it. ${params.textDocument.uri}`,
    );
    const forest = elmWorkspace.getForest();
    const imports = elmWorkspace.getImports();
    const document: VersionedTextDocumentIdentifier = params.textDocument;

    let tree: Tree | undefined = forest.getTree(document.uri);
    if (tree === undefined) {
      const fileContent: string = readFileSync(
        URI.parse(document.uri).fsPath,
        "utf8",
      );
      tree = this.parser.parse(fileContent);
    }

    if ("contentChanges" in params) {
      for (const changeEvent of params.contentChanges) {
        tree = this.parser.parse(changeEvent.text);
      }
    } else {
      tree = this.parser.parse(params.textDocument.text);
    }

    if (tree) {
      forest.setTree(document.uri, true, true, tree, true);

      // Figure out if we have files importing our changed file - update them
      const urisToRefresh = [];
      for (const uri in imports.imports) {
        if (imports.imports.hasOwnProperty(uri)) {
          const fileImports = imports.imports[uri];

          if (fileImports.some((a) => a.fromUri === document.uri)) {
            urisToRefresh.push(uri);
          }
        }
      }
      urisToRefresh.forEach((a) => {
        imports.updateImports(a, forest.getTree(a)!, forest);
      });

      // Refresh imports of the calling file
      imports.updateImports(document.uri, tree, forest);

      this.treeChangeEvent.fire({ uri: document.uri, tree });
    }
  };
}

function printTree(node: SyntaxNode, level: number = 0): string {
  const tab = Array.apply(0, Array(level))
    .map(() => "\t")
    .join("");
  const s = `${node.type}: ${
    node.text.length > 10 ? `${node.text.slice(0, 10)}...` : node.text
  }`;
  return `${tab}${s}\n${node.children.map((n) => printTree(n, level + 1))}`;
}
