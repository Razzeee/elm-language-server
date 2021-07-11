import {
  DiagnosticSeverity,
  DiagnosticTag,
  Range,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { IDiagnostic } from "../../src/providers/diagnostics/diagnosticsProvider";
import { ElmLsDiagnostics } from "../../src/providers/diagnostics/elmLsDiagnostics";
import { diagnosticsEquals } from "../../src/providers/diagnostics/fileDiagnostics";
import { Utils } from "../../src/util/utils";
import { getSourceFiles } from "../utils/sourceParser";
import { SourceTreeParser, srcUri } from "../utils/sourceTreeParser";
import { diff } from "jest-diff";
import path from "path";
import { describe, expect } from "@jest/globals";
import { fail } from "assert";

describe("ElmLsDiagnostics", () => {
  let elmDiagnostics: ElmLsDiagnostics;
  const treeParser = new SourceTreeParser();

  const debug = process.argv.find((arg) => arg === "--debug");
  const uri = URI.file(path.join(srcUri, "Main.elm")).toString();

  async function testDiagnostics(
    source: string,
    code: string,
    expectedDiagnostics: IDiagnostic[],
  ) {
    await treeParser.init();
    elmDiagnostics = new ElmLsDiagnostics();

    const sources = getSourceFiles(source);
    const program = await treeParser.getProgram(sources);

    let diagnostics: Array<IDiagnostic> = [];
    for (const fileName in sources) {
      const filePath = URI.file(path.join(srcUri, fileName)).toString();
      const sourceFile = program.getSourceFile(filePath);

      if (!sourceFile) {
        fail();
      }

      diagnostics = diagnostics.concat(
        elmDiagnostics
          .createDiagnostics(sourceFile, program)
          .filter((diagnostic) => diagnostic.data.code === code),
      );
    }

    const diagnosticsEqual = Utils.arrayEquals(
      diagnostics,
      expectedDiagnostics,
      diagnosticsEquals,
    );

    if (debug && !diagnosticsEqual) {
      console.log(diff(expectedDiagnostics, diagnostics));
    }

    expect(diagnosticsEqual).toBeTruthy();
  }

  describe("boolean case expressions", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: "Use an if expression instead of a case expression.",
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "boolean_case_expr",
        },
      };
    };

    it("boolean case true", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        True ->
            x
        _ -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 7, character: 18 },
        }),
      ]);
    });

    it("boolean case false", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        False ->
            x
        _ -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 7, character: 18 },
        }),
      ]);
    });

    it("no boolean case", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        Some ->
            x
        Other -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", []);
    });
  });

  describe("unused top level", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Unused top level definition \`${name}\``,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_top_level",
        },
      };
    };

    it("unused function", async () => {
      const source = `
module Bar exposing (foo)

foo = some

baz = 2

some = 1
			`;

      await testDiagnostics(source, "unused_top_level", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 3 },
          },
          "baz",
        ),
      ]);
    });

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("only used in self", async () => {
      const source = `
module Bar exposing (foo, Some(..)))

type Some = Thing

foo = 1

bar = bar + foo
			`;

      await testDiagnostics(source, "unused_top_level", [
        diagnosticWithRangeAndName(
          {
            start: { line: 7, character: 0 },
            end: { line: 7, character: 3 },
          },
          "bar",
        ),
      ]);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used binary imported function as prefix", async () => {
      const source = `
module Foo exposing (..)

import List.Extra exposing ((!!))

getItemAtIndex : Int -> Maybe String
getItemAtIndex index =
    let
        someList =
            [ "a", "b", "c" ]
    in
    (!!) someList index
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });
  });

  describe("unused import", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Unused import \`${name}\``,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_import",
        },
      };
    };

    it("used as qualified", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo = Bar.add 1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used as qualified in pattern", async () => {
      const source = `
module Main exposing (..)

import Bar

z a =
    case a of
        Bar.Z ->
            1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used in type reference", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo : Bar.Thing
foo = bar
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used in type alias", async () => {
      const source = `
module Foo exposing (..)

import Bar

type alias Thing = { name : Bar.Name }
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("unused but has exposing", async () => {
      const source = `
module Foo exposing (..)

import Bar exposing (baz)

foo = 1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("unused import", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo = 1
			`;

      await testDiagnostics(source, "unused_import", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 10 },
          },
          "Bar",
        ),
      ]);
    });

    it("no usage for alias", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = (+) 1 2
			`;

      await testDiagnostics(source, "unused_import", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 15 },
          },
          "B",
        ),
      ]);
    });

    it("no usage on both imports even if name is similar", async () => {
      const source = `
module Session exposing (..)

import Json.Decode
import Json.Decode.Pipeline
			`;

      await testDiagnostics(source, "unused_import", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 18 },
          },
          "Json.Decode",
        ),
        diagnosticWithRangeAndName(
          {
            start: { line: 4, character: 0 },
            end: { line: 4, character: 27 },
          },
          "Json.Decode.Pipeline",
        ),
      ]);
    });
  });

  describe("unused import alias", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Unused import alias \`${name}\``,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_alias",
        },
      };
    };

    it("no usage for alias with exposing", async () => {
      const source = `
module Foo exposing (..)

import Bar as B exposing (..)

foo = (+) 1 2
			`;

      await testDiagnostics(source, "unused_alias", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 11 },
            end: { line: 3, character: 15 },
          },
          "B",
        ),
      ]);
    });

    // This case is handled by unused_import
    it("unused alias but no exposing", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = 1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used as qualified", async () => {
      const source = `
module Foo exposing (..)

import Bar as B exposing (..)

foo = B.add 1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used as qualified in pattern", async () => {
      const source = `
module Main exposing (..)

import X as Y exposing (..)

z a =
    case a of
        Y.Z ->
            1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used in type reference", async () => {
      const source = `
module Foo exposing (..)

import Bar as B exposing (..)

foo : B.Thing
foo = bar
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used in type alias", async () => {
      const source = `
module Foo exposing (..)

import Bar as B exposing (..)

foo = B.math.add 1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used as qualified with nested record access", async () => {
      const source = `
module Foo exposing (..)


import Bar as B exposing (..)

type alias Thing = { name : B.Name }
			`;

      await testDiagnostics(source, "unused_alias", []);
    });
  });

  describe("unused imported value or type", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
      type: string,
    ): IDiagnostic => {
      return {
        message: `Unused imported ${type} \`${name}\``,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_imported_value",
        },
      };
    };

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used imported value as record update", async () => {
      const source = `
module Bar exposing (..)

import Foo exposing (empty)

addUsedVariable =
    { empty | name = "John" }
			`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..))

type Some = Thing

foo = 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("unused imported variable", async () => {
      const source = `
module Foo exposing (foo)

import Html exposing (div)

foo = 1
		`;

      await testDiagnostics(source, "unused_imported_value", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 22 },
            end: { line: 3, character: 25 },
          },
          "div",
          "value",
        ),
      ]);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("unused imported type", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Thing, Other)

x : Int -> Other
x y =
  Some.other y
		`;

      await testDiagnostics(source, "unused_imported_value", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 22 },
            end: { line: 3, character: 27 },
          },
          "Thing",
          "type",
        ),
      ]);
    });
  });

  describe("unused pattern variable", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Unused pattern variable \`${name}\``,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_pattern",
        },
      };
    };

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..))

type Some = Thing

foo = 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("unused in case pattern", async () => {
      const source = `
module Foo exposing (foo)

foo x =
  case x of
    Just y ->
      1
			`;

      await testDiagnostics(source, "unused_pattern", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 9 },
            end: { line: 5, character: 10 },
          },
          "y",
        ),
      ]);
    });

    it("unused in case pattern as single", async () => {
      const source = `
module Foo exposing (foo)

foo x =
  case x of
    y ->
      1
			`;

      await testDiagnostics(source, "unused_pattern", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 4 },
            end: { line: 5, character: 5 },
          },
          "y",
        ),
      ]);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (foo)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("unused {}", async () => {
      const source = `
module Foo exposing (foo)

foo value =
    case value of
        {} ->
            "test"
			`;

      await testDiagnostics(source, "unused_pattern", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 8 },
            end: { line: 5, character: 10 },
          },
          "",
        ),
      ]);
    });
  });

  describe("drop cons of item and list", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `If you cons an item to a literal list, then you can just put the item into the list.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "drop_cons_of_item_and_list",
        },
      };
    };

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ var
			`;

      await testDiagnostics(source, "drop_cons_of_item_and_list", []);
    });

    it("cons with literal list", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    1 :: [2 , 3]
			`;

      await testDiagnostics(source, "drop_cons_of_item_and_list", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 16 },
        }),
      ]);
    });
  });

  describe("map nothing to nothing", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `\`Nothing\` mapped to \`Nothing\` in case expression. Use Maybe.map or Maybe.andThen instead.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "map_nothing_to_nothing",
        },
      };
    };

    it("map nothing to nothing", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Just (a + 1)
    Nothing -> Nothing
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 22 },
        }),
      ]);
    });

    it("map nothing to something", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Just (a + 1)
    Nothing -> 0
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", []);
    });

    it("map something to nothing", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Nothing
    Nothing -> 0
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", []);
    });
  });

  describe("drop concat of lists", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `If you concatenate two lists, then you can merge them into one list.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "drop_concat_of_lists",
        },
      };
    };

    it("could use cons", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1] ++ [3, 4]
			`;

      await testDiagnostics(source, "drop_concat_of_lists", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 17 },
        }),
      ]);
    });

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ var
			`;

      await testDiagnostics(source, "drop_concat_of_lists", []);
    });

    it("concat multi element list", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ [3, 4]
			`;

      await testDiagnostics(source, "drop_concat_of_lists", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 20 },
        }),
      ]);
    });
  });

  describe("use cons over concat", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `If you concatenate two lists, but the first item is a single element list, then you should use the cons operator.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "use_cons_over_concat",
        },
      };
    };

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ bar
			`;

      await testDiagnostics(source, "use_cons_over_concat", []);
    });

    it("concat single item to var", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1] ++ bar
			`;

      await testDiagnostics(source, "use_cons_over_concat", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 14 },
        }),
      ]);
    });
  });

  describe("single field record", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `Using a record is obsolete if you only plan to store a single field in it.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "single_field_record",
        },
      };
    };

    it("single field", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 4, character: 2 },
          end: { line: 4, character: 13 },
        }),
      ]);
    });

    it("single field generic", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { a | x : Int }
			`;

      await testDiagnostics(source, "single_field_record", []);
    });

    it("multi field", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int
  , y : String
  }
			`;

      await testDiagnostics(source, "single_field_record", []);
    });

    it("single field nested", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int
  , y : { z : String }
  }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 5, character: 8 },
          end: { line: 5, character: 22 },
        }),
      ]);
    });

    it("single field in type", async () => {
      const source = `
module Bar exposing (foo)

type Foo =
  Bar { x : Int }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 4, character: 6 },
          end: { line: 4, character: 17 },
        }),
      ]);
    });

    it("single field as generic arg", async () => {
      const source = `
module Bar exposing (foo)

type alias Params x a =
    { x
        | id : String
        , label : String
        , action : a
    }
-- more type aliasses that extends from Params
type alias CheckboxParams a =
    Params { checked : Bool } (Bool -> a)
			`;

      await testDiagnostics(source, "single_field_record", []);
    });
  });

  describe("unnecessary list concat", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `You should just merge the arguments of \`List.concat\` to a single list.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "unnecessary_list_concat",
        },
      };
    };

    it("could merge", async () => {
      const source = `
module Bar exposing (foo)

foo =
    List.concat [ [1], [2] ]
			`;

      await testDiagnostics(source, "unnecessary_list_concat", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 4, character: 28 },
        }),
      ]);
    });

    it("could merge 2", async () => {
      const source = `
module Bar exposing (foo)

foo x =
  case x of
    DropConsOfItemAndList fileName range ->
        ( String.concat
            [ "Adding an item to the front of a literal list, but instead you can just put it in the list. "
            , fileName
            , " at "
            , rangeToString range
            ]
        , always (List.concat [ [ fileName ], [] ])
        , [ range ]
        , True
        )
			`;

      await testDiagnostics(source, "unnecessary_list_concat", [
        diagnosticWithRange({
          start: { line: 12, character: 18 },
          end: { line: 12, character: 50 },
        }),
      ]);
    });

    it("could not merge", async () => {
      const source = `
module Bar exposing (foo)

foo =
    List.concat [ bar, [2] ]
			`;

      await testDiagnostics(source, "unnecessary_list_concat", []);
    });

    it("could not merge 2", async () => {
      const source = `
module Bar exposing (foo)

test =
    let
        aList =
            if True then
                [ 2, 3 ]

            else
                []
    in
    List.concat
        [ [ 1 ]
        , aList
        , [ 4 ]
        ]
			`;

      await testDiagnostics(source, "unnecessary_list_concat", []);
    });
  });

  describe("unnecessary port module", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `Module is defined as a \`port\` module, but does not define any ports.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "unnecessary_port_module",
        },
      };
    };

    it("no ports", async () => {
      const source = `
port module Bar exposing (foo)

foo = 1

bar = 2

type alias Foo = {}

type Bar = Other
			`;

      await testDiagnostics(source, "unnecessary_port_module", [
        diagnosticWithRange({
          start: { line: 1, character: 0 },
          end: { line: 1, character: 30 },
        }),
      ]);
    });

    it("some ports", async () => {
      const source = `
port module Bar exposing (foo)

bar = 2

type alias Foo = {}

type Bar = Other

port foo : String -> Cmd msg
			`;

      await testDiagnostics(source, "unnecessary_port_module", []);
    });
  });

  describe("fully applied operator as prefix", () => {
    const diagnosticWithRange = (range: Range): IDiagnostic => {
      return {
        message: `Don't use fully applied prefix notation for operators.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        data: {
          uri,
          code: "no_uncurried_prefix",
        },
      };
    };

    it("prefix as application with two args", async () => {
      const source = `
module Foo exposing (..)

foo = (+) 1 2
			`;

      await testDiagnostics(source, "no_uncurried_prefix", [
        diagnosticWithRange({
          start: { line: 3, character: 6 },
          end: { line: 3, character: 13 },
        }),
      ]);
    });

    it("prefix as application with one arg", async () => {
      const source = `
module Foo exposing (..)

foo = (+) 1
			`;

      await testDiagnostics(source, "no_uncurried_prefix", []);
    });
  });

  describe("unused type alias", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Type alias \`${name}\` is not used.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_type_alias",
        },
      };
    };

    it("unused but exposed", async () => {
      const source = `
module Foo exposing (Bar)

type alias Bar = Int
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used in signature", async () => {
      const source = `
module Foo exposing (foo)

type alias Bar = Int

foo : Bar
foo = 1
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used as function", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

foo =
    Person "John" 12
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used in port", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

port foo : Person -> Cmd msg
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used alias in record", async () => {
      const source = `
module Foo exposing (InputInterfaces)

type alias InputFiles =
    List String

type alias InputInterfaces =
    List ( String, InputFiles )
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used alias in type", async () => {
      const source = `
module Foo exposing (Patch(..))

type alias InputFiles =
    List String

type Patch
    = OnFiles InputFiles
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used type alias in different file", async () => {
      const source = `
--@ Model.elm
module Model exposing (..)


type alias IAmUsed =
    { used : Bool
    , optional : Bool
    }

--@ Main.elm
module Main exposing (main)

import Html
import Model


main : Html.Html msg
main =
    view example


example : Model.IAmUsed
example =
    { used = True
    , optional = False
    }


view : Model.IAmUsed -> Html.Html msg
view blah =
    Html.text <|
        if blah.used then
            "used"

        else
            "not used"
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("unused type alias", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

foo = 1
			`;

      await testDiagnostics(source, "unused_type_alias", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 47 },
          },
          "Person",
        ),
      ]);
    });
  });

  describe("unused value constructor", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): IDiagnostic => {
      return {
        message: `Value constructor \`${name}\` is not used.`,
        source: "ElmLS",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
        data: {
          uri,
          code: "unused_value_constructor",
        },
      };
    };

    it("unused but exposed", async () => {
      const source = `
module Foo exposing (Foo(..))

type Foo = Bar
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("used and not exposed", async () => {
      const source = `
module Foo exposing (foo)

type Foo = Bar Int

foo = Bar 1
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("unused and not exposed", async () => {
      const source = `
module Foo exposing (foo)

type Foo = Bar Int

foo (Bar i) = i
			`;

      await testDiagnostics(source, "unused_value_constructor", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 11 },
            end: { line: 3, character: 18 },
          },
          "Bar",
        ),
      ]);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("unused value constructor not exposed", async () => {
      const source = `
module Bar exposing (Some)

type Some = Thing | Other
			`;

      await testDiagnostics(source, "unused_value_constructor", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 12 },
            end: { line: 3, character: 17 },
          },
          "Thing",
        ),
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 20 },
            end: { line: 3, character: 25 },
          },
          "Other",
        ),
      ]);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..)))

type Some = Thing

foo = 1
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("used in case expr", async () => {
      const source = `
module Bar exposing (text)

type Language
    = Italian
    | English


text : String -> String -> Html msg
text en it language =
    Html.text <|
        case language of
            English ->
                en

            Italian ->
                it
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("used in case expr with pattern", async () => {
      const source = `
module Bar exposing (text)

type Language
    = Italian (List String)
    | English (List String)


text : String -> String -> Html msg
text en it language =
    Html.text <|
        case language of
            English items ->
                en

            Italian items ->
                it
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("used in a different file", async () => {
      const source = `
--@ Main.elm
module Main exposing (..)

import B exposing (C(..))

f : Int -> C
f x =
    if x > 1 then
        Something
    else
        SomethingElse

--@ B.elm
module B exposing (..)

type C
    = Something
    | SomethingElse
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });
  });
});
