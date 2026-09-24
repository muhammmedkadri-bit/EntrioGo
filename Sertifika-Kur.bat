@echo off
title EntrioGo SSL Sertifikasi Kurulumu
chcp 65001 >nul
color 0A
echo ========================================================
echo   EntrioGo 100 Yillik Guvenli SSL Sertifikasi Kuruluyor
echo ========================================================
echo.
echo Acilacak olan Guvenlik penceresinde "EVET" (YES) butonuna basin.
echo.
certutil -addstore -user Root "C:\Users\Tan\Desktop\EntrioGo\print-agent\ca.crt"
echo.
echo ========================================================
echo   TAMAMLANDI! Artik tarayicinizda guvenli calisacak.
echo ========================================================
echo.
pause
