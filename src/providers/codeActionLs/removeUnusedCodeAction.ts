import { TextEdit, Range, Position } from "vscode-languageserver";
import { ISourceFile } from "../../compiler/forest";
import { RefactorEditUtils } from "../../util/refactorEditUtils";
import { TreeUtils } from "../../util/treeUtils";
import { Utils } from "../../util/utils";
import { CodeActionProvider } from "../codeActionProvider";
import {
  convertFromCompilerDiagnostic,
  IDiagnostic,
} from "../diagnostics/diagnosticsProvider";

const errorCodes = [
  "unused_import",
  "unused_imported_value",
  "unused_alias",
  "unused_top_level",
  "unused_pattern",
  "unused_value_constructor",
  "unused_type_alias",
];
const fixId = "remove_unused";
CodeActionProvider.registerCodeAction({
  errorCodes,
  fixId,
  getCodeActions: (params) => {
    return (<IDiagnostic[]>params.context.diagnostics)
      .map((diagnostic) => {
        const { title, edits } = getEditsForDiagnostic(
          diagnostic,
          params.sourceFile,
        );

        if (title) {
          return CodeActionProvider.getCodeAction(params, title, edits);
        }
      })
      .filter(Utils.notUndefined);
  },
  getFixAllCodeAction: (params) => {
    const importsMap = new Map<string, Set<string>>();
    return CodeActionProvider.getFixAllCodeAction(
      "Remove all reported unused code",
      params,
      errorCodes,
      fixId,
      (edits, diagnostic) => {
        edits.push(
          ...getEditsForDiagnostic(
            convertFromCompilerDiagnostic(diagnostic),
            params.sourceFile,
            importsMap,
          ).edits,
        );
      },
    );
  },
});

function getEditsForDiagnostic(
  diagnostic: IDiagnostic,
  sourceFile: ISourceFile,
  importsMap?: Map<string, Set<string>>,
): { title?: string; edits: TextEdit[] } {
  const addImportToSet = (module: string, value: string): void => {
    if (!importsMap) {
      return;
    }

    let existing = importsMap.get(module);

    if (!existing) {
      existing = new Set<string>();
      importsMap.set(module, existing);
    }

    existing.add(value);
  };

  switch (diagnostic.data.code) {
    case "unused_import": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.end,
      );

      const moduleName = node.childForFieldName("moduleName");
      return {
        title: `Remove unused import \`${moduleName?.text ?? node.text}\``,
        edits: [
          TextEdit.del(
            Range.create(
              diagnostic.range.start,
              Position.create(diagnostic.range.end.line + 1, 0),
            ),
          ),
        ],
      };
    }

    case "unused_alias": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.end,
      );

      return {
        title: `Remove unused alias \`${node.text}\``,
        edits: [
          TextEdit.del({
            start: {
              line: diagnostic.range.start.line,
              character: diagnostic.range.start.character - 1,
            },
            end: diagnostic.range.end,
          }),
        ],
      };
    }

    case "unused_top_level": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.start,
      );

      const edit = RefactorEditUtils.removeFunction(node);

      if (!edit) {
        break;
      }

      return {
        title: `Remove function \`${node.text}\``,
        edits: [edit],
      };
    }

    case "unused_pattern": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.start,
      );

      const edit =
        node.parent?.parent?.type === "record_pattern"
          ? RefactorEditUtils.removeRecordPatternValue(node.parent)
          : TextEdit.replace(diagnostic.range, "_");

      return { title: `Fix unused pattern \`${node.text}\``, edits: [edit] };
    }

    case "unused_value_constructor": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.start,
      );

      const edit = RefactorEditUtils.removeTypeValue(node);

      if (!edit) {
        break;
      }

      return {
        title: `Remove unused value constructor \`${node.text}\``,
        edits: [edit],
      };
    }

    case "unused_type_alias": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.start,
      );

      const edit = RefactorEditUtils.removeTypeAlias(node);

      if (!edit) {
        break;
      }

      return {
        title: `Remove unused type alias \`${node.text}\``,
        edits: [edit],
      };
    }

    case "unused_imported_value": {
      const node = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        diagnostic.range.start,
      );

      const importClause = TreeUtils.findParentOfType("import_clause", node);

      if (!importClause) {
        break;
      }

      const moduleName = TreeUtils.findFirstNamedChildOfType(
        "upper_case_qid",
        importClause,
      );

      if (!moduleName) {
        break;
      }

      const allValues =
        importClause
          .childForFieldName("exposing")
          ?.namedChildren.filter(
            (n) => n.type === "exposed_value" || n.type === "exposed_type",
          )
          .map((n) => n.text) ?? [];

      // This is only for the fix all code action
      // If we are removing all import values, we need to remove the entire exposing
      addImportToSet(moduleName.text, node.text);
      if (
        importsMap &&
        allValues.every((val) => importsMap.get(moduleName.text)?.has(val))
      ) {
        const removeExposingExit = RefactorEditUtils.removeImportExposingList(
          sourceFile.tree,
          moduleName.text,
        );
        if (removeExposingExit) {
          return {
            edits: [removeExposingExit],
          };
        }
      }

      const removeValueEdit = RefactorEditUtils.removeValueFromImport(
        sourceFile.tree,
        moduleName.text,
        node.text,
      );

      if (removeValueEdit) {
        // Detect if there are 2 or more values at the end of a exposing list that are removed
        // For example, if we are removing `foo` and `bar` in `(func, foo, bar)`
        // We need to add another edit to remove the comma before `foo`
        if (importsMap && allValues.length > 2) {
          allValues.reverse();
          const firstUsedIndex = allValues.findIndex(
            (val) => !importsMap.get(moduleName.text)?.has(val),
          );

          if (firstUsedIndex >= 2) {
            const val = allValues[firstUsedIndex - 1];

            const removeValueWithCommaEdit =
              RefactorEditUtils.removeValueFromImport(
                sourceFile.tree,
                moduleName.text,
                val,
                /* forceRemovePrecedingComma */ true,
              );

            if (removeValueWithCommaEdit) {
              return { edits: [removeValueWithCommaEdit, removeValueEdit] };
            }
          }
        }

        return {
          title: `Remove unused ${
            node.type === "exposed_type" ? "type" : "value"
          } \`${node.text}\``,
          edits: [removeValueEdit],
        };
      }
    }
  }

  return { edits: [] };
}
