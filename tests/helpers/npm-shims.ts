/**
 * What npm writes into a win32 prefix for the `codemie` bin of `@codemieai/code`: `codemie.cmd` and the `codemie`
 * sh shim, each naming the package's script under `node_modules` beside it.
 */
export const NPM_WIN32_SHIMS = {
  'codemie.cmd': [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      '"%dp0%\\node_modules\\@codemieai\\code\\bin\\codemie.js" %*',
    '',
  ].join('\r\n'),
  codemie: [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    '',
    'if [ -x "$basedir/node" ]; then',
    '  exec "$basedir/node"  "$basedir/node_modules/@codemieai/code/bin/codemie.js" "$@"',
    'else ',
    '  exec node  "$basedir/node_modules/@codemieai/code/bin/codemie.js" "$@"',
    'fi',
    '',
  ].join('\n'),
};
