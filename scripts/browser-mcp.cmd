@echo off
setlocal

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "NODE_DIR=%ROOT_DIR%\.runtime\node-v22.12.0-win-x64"
if not exist "%NODE_DIR%\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
set "NPM_DIR=%ProgramFiles%\nodejs\node_modules\npm\bin"
set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "CHROME_PROFILE=%ROOT_DIR%\.runtime\chrome-profile"
set "CHROME_PORT=9222"
set "CHROME_URL=http://127.0.0.1:%CHROME_PORT%"
set "NPX_CLI_JS=%NPM_DIR%\npx-cli.js"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "PATH=%NODE_DIR%;%PATH%"

if not exist "%CHROME_PROFILE%" mkdir "%CHROME_PROFILE%" >nul 2>nul

call :PortReady
if errorlevel 1 (
  start "" "%CHROME_EXE%" --remote-debugging-port=%CHROME_PORT% --user-data-dir="%CHROME_PROFILE%" --no-first-run --no-default-browser-check --new-window about:blank
  call :WaitForPort
  if errorlevel 1 (
    echo Failed to start Chrome on port %CHROME_PORT%.
    exit /b 1
  )
)

call "%NODE_EXE%" "%NPX_CLI_JS%" -y chrome-devtools-mcp@latest --browser-url %CHROME_URL% %*
exit /b %ERRORLEVEL%

:PortReady
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%CHROME_PORT%/json/version; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
exit /b %ERRORLEVEL%

:WaitForPort
set /a COUNT=0
:WaitLoop
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%CHROME_PORT%/json/version; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 exit /b 0
set /a COUNT+=1
if %COUNT% GEQ 30 exit /b 1
timeout /t 1 /nobreak >nul
goto WaitLoop
