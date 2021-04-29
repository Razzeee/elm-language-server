# elm-language-server

[![Build Status](https://github.com/elm-tooling/elm-language-server/workflows/Lint%20and%20test/badge.svg)](https://github.com/elm-tooling/elm-language-server/actions)

This is the language server implementation for the Elm programming language.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Installation](#installation)
  - [Alternative: Compile and install from source](#alternative-compile-and-install-from-source)
  - [Alternative: Install with Nix](#alternative-install-with-nix)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Features](#features)
- [Server Settings](#server-settings)
- [Editor Support](#editor-support)
  - [VSCode](#vscode)
  - [Vim](#vim)
    - [coc.nvim](#cocnvim)
    - [ALE](#ale)
    - [LanguageClient](#languageclient)
  - [Kakoune](#kakoune)
    - [kak-lsp](#kak-lsp)
  - [Emacs](#emacs)
    - [Emacs Doom](#emacs-doom)
  - [Sublime](#sublime)
- [Awesome libraries this is based on](#awesome-libraries-this-is-based-on)
- [Contributing](#contributing)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation

Note for VSCode users: The [plugin](https://github.com/elm-tooling/elm-language-client-vscode) contains the language-server. No installation necessary.

The server can be installed via `npm` (or from source).

```sh
npm install -g @elm-tooling/elm-language-server
```

Then, you should be able to run the language server with the following command:

```sh
elm-language-server
```

You might need to use this, if your using powershell:

```powershell
elm-language-server.cmd
```

Follow the instructions below to integrate the language server into your editor.

### Alternative: Compile and install from source

First, clone this repo and compile it. `npm link` will add `elm-language-server` to the `PATH`.

```sh
git clone git@github.com:elm-tooling/elm-language-server.git
cd elm-language-server
npm install
npm run compile
npm link
```

### Alternative: Install with [Nix](https://nixos.org)

`elm-languager-server` and its [dependencies](https://github.com/elm-tooling/elm-language-server#requirements) are available in [`nixpkgs`](https://github.com/NixOS/nixpkgs/blob/master/pkgs/development/compilers/elm/default.nix).

```sh
nix-env -i -A nixpkgs.elmPackages.elm-language-server
```

## Requirements

You will need to install `elm` and `elm-test` to get all diagnostics and `elm-format` for formatting. Alternatively you can also just install these to your local npm `package.json`.

```sh
npm install -g elm elm-test elm-format
```

Or use local versions from your `node_modules` directory, if you want to do that you need to set the paths, via the settings (e.g. set `elmPath` to `./node_modules/.bin/elm`).

## Configuration

Create an [elm-tooling.json](https://elm-tooling.github.io/elm-tooling-cli/spec) file next to your `elm.json` to configure the language server.

Currently there’s just one thing that you can configure: entrypoints. The language server runs `elm make` to get type errors. By default `elm make` is run on the current file only. To get errors for the entire project you can specify your entrypoint files – basically, those with `main =` in them. Then the language server will run `elm make` on those instead.

Example `elm-tooling.json`:

```json
{
  "entrypoints": ["./src/Main.elm"]
}
```

The entrypoints are relative to the directory where your `elm.json` and `elm-tooling.json` is and must start with `./`.

Check out the [elm-tooling](https://elm-tooling.github.io/elm-tooling-cli/) CLI for creating and validating your `elm-tooling.json`! You can run it without installing:

```
npx elm-tooling init
```

## Features

Supports Elm 0.19 and up

| Feature          | Description                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| diagnostics      | Provided via `elm`, `elm-test` and our own type inference and linter                                                                                 |
| formatting       | Provided via `elm-format` and post-processed to only return a diff of changes. This way it should not be as intrusive as running `elm-format` normal |
| codeLenses       | Currently only shows if a type alias, custom type or function is exposed from that module                                                            |
| completions      | Show completions for the current file and snippets                                                                                                   |
| definitions      | Enables you to jump to the definition of a type alias, module, custom type or function                                                               |
| documentSymbols  | Identifies all symbols in a document.                                                                                                                |
| folding          | Let's you fold the code on certain Elm constructs                                                                                                    |
| hover            | Shows type annotations and documentation for a type alias, module, custom type or function                                                           |
| linkedEditing    | Enables auto renaming a function name when the type annotation name is edited, or vice versa                                                         |
| references       | Lists all references to a type alias, module, custom type or function                                                                                |
| rename           | Enables you to rename a type alias, module, custom type or function                                                                                  |
| workspaceSymbols | Identifies all symbols in the current workspace                                                                                                      |
| selectionRange   | Enables navigation by selectionRange (extend selection for e.g.)                                                                                     |

## Server Settings

This server contributes the following settings:

- `elmLS.trace.server`: Enable/disable trace logging of client and server communication
- `elmLS.elmPath`: The path to your `elm` executable. Should be empty by default, in that case it will assume the name and try to first get it from a local npm installation or a global one. If you set it manually it will not try to load from the npm folder.
- `elmLS.elmReviewPath`: The path to your `elm-review` executable. Should be empty by default, in that case it will assume the name and try to first get it from a local npm installation or a global one. If you set it manually it will not try to load from the npm folder.
- `elmLS.elmFormatPath`: The path to your `elm-format` executable. Should be empty by default, in that case it will assume the name and try to first get it from a local npm installation or a global one. If you set it manually it will not try to load from the npm folder.
- `elmLS.elmTestPath`: The path to your `elm-test` executable. Should be empty by default, in that case it will assume the name and try to first get it from a local npm installation or a global one. If you set it manually it will not try to load from the npm folder.
- `elmLS.disableElmLSDiagnostics`: Enable/Disable linting diagnostics from the language server.
- `elmLS.skipInstallPackageConfirmation`: Skip confirmation for the Install Package code action.
- `elmLS.onlyUpdateDiagnosticsOnSave`: Only update compiler diagnostics on save, not on document change.

Settings may need a restart to be applied.

## Editor Support

| Editor                                                                                  |    Diagnostics     |     Formatting     |    Code Lenses     |    Completions     |    Definitions     |  Document Symbols  |      Folding       |       Hover        |   Linked Editing   |     References     |       Rename       | Workspace Symbols  |
| --------------------------------------------------------------------------------------- | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: | :----------------: |
| [VSCode](https://github.com/elm-tooling/elm-language-server#vscode)                     | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |
| [VIM CoC](https://github.com/elm-tooling/elm-language-server#cocnvim)                   | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |        :x:         | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |
| [VIM LanguageClient](https://github.com/elm-tooling/elm-language-server#languageClient) | :heavy_check_mark: | :heavy_check_mark: |  :grey_question:   | :heavy_check_mark: |  :grey_question:   |  :grey_question:   |  :grey_question:   |  :grey_question:   |        :x:         |  :grey_question:   |  :grey_question:   |  :grey_question:   |
| [VIM ALE](https://github.com/elm-tooling/elm-language-server#ale)                       | :heavy_check_mark: |        :x:         |        :x:         |  :grey_question:   | :heavy_check_mark: |        :x:         |        :x:         | :heavy_check_mark: |        :x:         | :heavy_check_mark: |        :x:         | :heavy_check_mark: |
| [Kakoune](https://github.com/elm-tooling/elm-language-server#kak-lsp)                   | :heavy_check_mark: | :heavy_check_mark: |  :grey_question:   | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |  :grey_question:   | :heavy_check_mark: |        :x:         | :heavy_check_mark: | :heavy_check_mark: |  :grey_question:   |
| [Emacs](https://github.com/elm-tooling/elm-language-server#emacs)                       | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |  :grey_question:   | :heavy_check_mark: |        :x:         | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |
| [Sublime](https://github.com/elm-tooling/elm-language-server#sublime)                   | :heavy_check_mark: | :heavy_check_mark: |        :x:         | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |        :x:         | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: |

### VSCode

Just install the [`elm-tooling/elm-language-client-vscode`](https://github.com/elm-tooling/elm-language-client-vscode) plugin from the [VSCode MarketPlace](https://marketplace.visualstudio.com/items?itemName=Elmtooling.elm-ls-vscode)

To enable linked editing in VSCode, use the setting `"editor.linkedEditing": true`.

### Vim

There are [general setup instructions and FAQ for Vim](https://github.com/elm-tooling/elm-vim).

It's recommended to install [syntax highlighting](https://github.com/andys8/vim-elm-syntax), which also adds the required [detection of elm as `filetype`](https://github.com/andys8/vim-elm-syntax/blob/d614325a037982489574012e4db04d7f8f134c17/ftdetect/elm.vim#L3). An example vim configuration can be found in [elm-vim/vim-config-example](https://github.com/elm-tooling/elm-vim/tree/main/vim-config-example).

#### coc.nvim

To enable support with [coc.nvim](https://github.com/neoclide/coc.nvim), run `:CocConfig` and add the language server config below.

If needed, you can set the paths to `elm`, `elm-test` and `elm-format` with the `elmPath`, `elmTestPath` and `elmFormatPath` variables.

```jsonc
{
  "languageserver": {
    "elmLS": {
      "command": "elm-language-server",
      "filetypes": ["elm"],
      "rootPatterns": ["elm.json"]
    }
  },
  // If you use neovim you can enable codelenses with this
  "codeLens.enable": true
}
```

Much of this is covered in the [Example vim configuration](https://github.com/neoclide/coc.nvim#example-vim-configuration) section in Coc's readme.

| Feature           | How to use it                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diagnostics       | `:CocList diagnostics`<br />Configure refresh with `"diagnostic.refreshAfterSave": false`                                                                                |
| Formatting        | `:call CocAction('format')`                                                                                                                                              |
| CodeLenses        | Requires Neovim. Add `"coc.preferences.codeLens.enable": true` to your `coc-settings.json` through `:CocConfig`                                                          |
| Completions       | On by default, see [Completion with sources](https://github.com/neoclide/coc.nvim/wiki/Completion-with-sources) for customizations                                       |
| Definitions       | Provided as `<Plug>` mapping so that you can set it yourself, e.g. <br /> `nmap <silent> gd <Plug>(coc-definition)` <br/> `nmap <silent> gy <Plug>(coc-type-definition)` |
| DocumentSymbols   | `:CocList outline`                                                                                                                                                       |
| Folding           | You must `set foldmethod=manual` in your `vimrc`, one set Coc will handle folding with the usual commands, `zc`, `zo`, etc                                               |
| Hover             | `:call CocAction('doHover')`                                                                                                                                             |
| References        | Provided as a `<Plug>` mapping, e.g. `nmap <silent> gr <Plug>(coc-references)`                                                                                           |
| Rename            | Provided as a `<Plug>` mapping, e.g. `nmap <leader>rn <Plug>(coc-rename)`                                                                                                |
| Workspace Symbols | `:CocList symbols`                                                                                                                                                       |

#### ALE

[ALE](https://github.com/dense-analysis/ale) contains the `elm_ls` linter.

```
let g:ale_linters = { 'elm': ['elm_ls'] }
```

If needed, you can set the paths to `elm`, `elm-test` and `elm-format`. The configuration can be [found here](https://github.com/dense-analysis/ale/blob/master/doc/ale-elm.txt)

```
let g:ale_elm_ls_use_global = 1
let g:ale_elm_ls_executable = "/path/to/elm-language-server"
let g:ale_elm_ls_elm_path = "/path/to/elm"
let g:ale_elm_ls_elm_format_path = "/path/to/elm-format"
let g:ale_elm_ls_elm_test_path = "/path/to/elm-test"
```

| Feature           | How to use it                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diagnostics       | `:ALENext`/`:ALEPrevious`<br />Configure refresh with `let g:ale_lint_on_text_changed = 0`<br />`let g:ale_lint_on_insert_leave = 1` <br /> `let g:ale_lint_on_save = 1` |
| Formatting        | ALE doesn't currently support this through the language server integration, but `elm-format` is a supported ALE Fixer                                                    |
| CodeLenses        | Not currently supported                                                                                                                                                  |
| Completions       | On by default, see `:h ale-completion` for more info                                                                                                                     |
| Definitions       | `:ALEGoToDefinition`, `:ALEGoToTypeDefinition`, see `:h ale-go-to-definition` and `:h ale-go-to-type-definition`                                                         |
| DocumentSymbols   | Only workspace symbols are currently supported                                                                                                                           |
| Folding           | Not currently supported                                                                                                                                                  |
| Hover             | `:ALEHover`                                                                                                                                                              |
| References        | `:ALEFindReferences`                                                                                                                                                     |
| Rename            | Not currently supported                                                                                                                                                  |
| Workspace Symbols | `:ALESymbolSearch <query>`                                                                                                                                               |

#### LanguageClient

To use this language server with [LanguageClient](https://github.com/autozimu/LanguageClient-neovim)
add the following configuration to you neovim/vim.

```viml
let g:LanguageClient_serverCommands = {
  \ 'elm': ['elm-language-server'],
  \ }

let g:LanguageClient_rootMarkers = {
  \ 'elm': ['elm.json'],
  \ }
```

### Kakoune

#### kak-lsp

First install [kak-lsp](https://github.com/ul/kak-lsp), and enable it in the kakrc. One way would be to add these lines to your .config/kak/kakrc file:

```sh
eval %sh{kak-lsp --kakoune -s $kak_session}
lsp-enable
```

Then, assuming installation of `elm-language-server`, `elm-format`, and `elm-test`, add this section to your `.config/kak-lsp/kak-lsp.toml` file:

```toml
[language.elm]
filetypes = ["elm"]
roots = ["elm.json"]
command = "elm-language-server"
```

### Emacs

The language client is included in [lsp-mode](https://github.com/emacs-lsp/lsp-mode), specifically [here](https://github.com/emacs-lsp/lsp-mode/blob/master/lsp-elm.el). See specifically [this section](https://github.com/emacs-lsp/lsp-mode#use-package) for a minimal use-package configuration for lsp-mode.

#### Emacs Doom

- Uncomment `lsp` and `elm` in your configuration file `.doom.d/init.el` and add the `+lsp` feature flag to the elm layer:

```elisp
lsp
(elm +lsp)
```

- Optional configuration for [lsp-mode](https://github.com/emacs-lsp/lsp-mode) and [lsp-ui-mode](https://github.com/emacs-lsp/lsp-ui). Add this to your `.doom.d/config.el`:

```elisp
(after! lsp
  (setq lsp-enable-symbol-highlighting nil)
  )
(after! lsp-ui
  (setq lsp-ui-doc-max-width 100)
  (setq lsp-ui-doc-max-height 30)
  (setq company-lsp-cache-candidates nil)
  )
```

- Run `~/.emacs.d/bin/doom sync`

| Feature         | How to use it                                                |
| --------------- | ------------------------------------------------------------ |
| Diagnostics     | On by default                                                |
| Formatting      | On save                                                      |
| CodeLenses      | `lsp-lens-mode`, `lsp-show-lens`                             |
| Completions     | On by default                                                |
| Definitions     | `lsp-find-definition`, `lsp-ui-peek-find-definitions`        |
| DocumentSymbols | `lsp-ui-imenu`                                               |
| Folding         | `+fold/open`, `+fold/close`                                  |
| Hover           | `lsp-ui-sideline-mode`, `lsp-ui-doc-mode`, `lsp-ui-show-doc` |
| References      | `lsp-ui-peek-find-references`, `lsp-find-references`         |
| Rename          | `lsp-rename`                                                 |
| SelectionRange  | `lsp-extend-selection`                                       |

### Sublime

1. Install [Elm Syntax Highlighting](https://packagecontrol.io/packages/Elm%20Syntax%20Highlighting), [LSP](https://packagecontrol.io/packages/LSP) and [LSP-elm](https://packagecontrol.io/packages/LSP-elm) from Package Control.
1. Restart Sublime.

You should now be able to use the integrations from Sublime. You might want to read about [the features offered](https://lsp.readthedocs.io/en/latest/features/)

## Awesome libraries this is based on

- [elm-format](https://github.com/avh4/elm-format)
- [elm-test](https://github.com/rtfeldman/node-test-runner)
- [tree-sitter-elm](https://github.com/Razzeee/tree-sitter-elm)

## Contributing

Please do :)
As the best thing about a language server is that multiple clients will improve that way.
