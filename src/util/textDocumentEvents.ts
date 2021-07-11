import { EventEmitter } from "events";
import { container } from "tsyringe";
import {
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DidSaveTextDocumentParams,
  TextDocumentsConfiguration,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { IDocumentEvents } from "./documentEvents";

// This is loosely based on https://github.com/Microsoft/vscode-languageserver-node/blob/73180893ca/server/src/main.ts#L124
// With some simplifications and the ability to support multiple listeners
export class TextDocumentEvents extends EventEmitter {
  // a single store of documents shared by all workspaces
  private _documents: { [uri: string]: TextDocument };
  private _configuration: TextDocumentsConfiguration<TextDocument> =
    TextDocument;

  constructor() {
    super();
    const events = container.resolve<IDocumentEvents>("DocumentEvents");
    this._documents = Object.create(null);

    events.on("open", (params: DidOpenTextDocumentParams) => {
      const td = params.textDocument;
      const document = this._configuration.create(
        td.uri,
        td.languageId,
        td.version,
        td.text,
      );
      this._documents[params.textDocument.uri] = document;
      this.emit("open", Object.freeze({ document, ...params }));
    });

    events.on("change", (params: DidChangeTextDocumentParams) => {
      const td = params.textDocument;
      const changes = params.contentChanges;
      if (changes.length === 0) {
        return;
      }

      let document = this._documents[td.uri];

      const { version } = td;
      if (version === null || version === void 0) {
        throw new Error(
          `Received document change event for ${td.uri} without valid version identifier`,
        );
      }

      document = this._configuration.update(document, changes, version);

      this._documents[td.uri] = document;

      this.emit("change", Object.freeze({ document, ...params }));
    });

    events.on("save", (params: DidSaveTextDocumentParams) => {
      const document = this._documents[params.textDocument.uri];
      if (document) {
        this.emit("save", Object.freeze({ document, ...params }));
      }
    });

    events.on("close", (params: DidCloseTextDocumentParams) => {
      const document = this._documents[params.textDocument.uri];
      if (document) {
        delete this._documents[params.textDocument.uri];
        this.emit("close", Object.freeze({ document, ...params }));
      }
    });
  }

  /**
   * Returns the document for the given URI. Returns undefined if
   * the document is not managed by this instance.
   *
   * @param uri The text document's URI to retrieve.
   * @return the text document or `undefined`.
   */
  public get(uri: string): TextDocument | undefined {
    return this._documents[uri];
  }

  public getManagedUris(): string[] {
    return Object.keys(this._documents);
  }
}
