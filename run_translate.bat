@echo off
setlocal

cd /d "%~dp0"

set "JSON_PATH=%TEMP%\PSTranslate\ps_text_layers.json"
set "CONFIG_PATH=%~dp0config.json"

if not exist "%JSON_PATH%" (
    echo Translation JSON was not found:
    echo   "%JSON_PATH%"
    echo.
    echo Open the PSD in Photoshop and run photoshop_export.jsx first.
    pause
    exit /b 1
)

if not exist "%CONFIG_PATH%" (
    echo config.json was not found:
    echo   "%CONFIG_PATH%"
    pause
    exit /b 1
)

where py >nul 2>nul
if "%ERRORLEVEL%"=="0" goto use_py

where python >nul 2>nul
if "%ERRORLEVEL%"=="0" goto use_python

echo Python 3 was not found. Install Python 3.8 or newer and try again.
pause
exit /b 1

:use_py
py -3 "%~dp0ps_text_translate.py" --json "%JSON_PATH%" --config "%CONFIG_PATH%" %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finished

:use_python
python "%~dp0ps_text_translate.py" --json "%JSON_PATH%" --config "%CONFIG_PATH%" %*
set "EXIT_CODE=%ERRORLEVEL%"

:finished

echo.
if not "%EXIT_CODE%"=="0" (
    echo Translation finished with errors. Check logs\ps_text_translate.log.
    echo Layers that failed will be skipped by photoshop_apply.jsx.
    pause
    exit /b %EXIT_CODE%
)

echo Translation JSON updated:
echo   "%JSON_PATH%"
echo.
echo Return to Photoshop and run photoshop_apply.jsx.
pause
exit /b 0
