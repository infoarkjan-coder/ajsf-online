package com.arkjan.ajsfonline;

import android.app.Activity;
import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import android.webkit.GeolocationPermissions;
import android.os.Build;
import android.app.DownloadManager;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.OutputStream;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://ajsf-online.vercel.app/?app_refresh=20261119-camera-signature";
    private static final String APK_CACHE_BUST = "ajsf-camera-signature-20261119";
    private static final String APP_HOST = "ajsf-online.vercel.app";
    private static final int FILE_CHOOSER_REQUEST = 4102;

    private WebView webView;
    private WebView printWebView;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermissionRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF123F35);
        getWindow().setNavigationBarColor(0xFF123F35);

        webView = new WebView(this);
        webView.addJavascriptInterface(new AjsfPrintBridge(), "AJSFNativePrint");
        webView.addJavascriptInterface(new AjsfDownloadBridge(), "AJSFNativeDownload");
        setContentView(webView);

        webView.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                                | android.view.WindowInsets.Type.displayCutout());
                left = safe.left;
                top = safe.top;
                right = safe.right;
                bottom = safe.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(left, top, right, bottom);
            return insets;
        });
        webView.requestApplyInsets();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleExternalUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleExternalUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Remove stale website Service Worker/cache from older APK sessions, then reload once.
                view.evaluateJavascript("(function() {" +
                        "var marker='ajsf-apk-cachefix-20261119-camera';" +
                        "if (new URLSearchParams(location.search).get('apk_cache_bust') === marker) return;" +
                        "var jobs=[];" +
                        "if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) jobs.push(navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}));" +
                        "if (window.caches && caches.keys) jobs.push(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}));" +
                        "Promise.all(jobs).finally(function(){var u=new URL(location.href);u.searchParams.set('apk_cache_bust',marker);location.replace(u.toString());});" +
                        "})()", null);
                // APK-only UI cleanup. The hosted website remains unchanged.
                view.evaluateJavascript("(function() {" +
                        "var labels = ['तीन Admin Login बनाएँ', 'Customer Login बनाएँ'];" +
                        "var hideAjsfButtons = function() {" +
                        "document.querySelectorAll('button,[role=button],a').forEach(function(el) {" +
                        "var label = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();" +
                        "if (labels.some(function(item) { return label.indexOf(item) !== -1; })) {" +
                        "el.style.setProperty('display', 'none', 'important');" +
                        "el.setAttribute('aria-hidden', 'true');" +
                        "}" +
                        "});" +
                        "};" +
                        "hideAjsfButtons();" +
                        "if (!window.__ajsfApkHideObserver && document.documentElement) {" +
                        "window.__ajsfApkHideObserver = new MutationObserver(hideAjsfButtons);" +
                        "window.__ajsfApkHideObserver.observe(document.documentElement, {childList:true, subtree:true, characterData:true});" +
                        "}" +
                        "})()", null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "इंटरनेट कनेक्शन जाँचें और दोबारा कोशिश करें", Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] resources = request.getResources();
                    java.util.ArrayList<String> androidPermissions = new java.util.ArrayList<>();
                    for (String resource : resources) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            androidPermissions.add(Manifest.permission.CAMERA);
                        } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            androidPermissions.add(Manifest.permission.RECORD_AUDIO);
                        }
                    }
                    if (androidPermissions.isEmpty()) {
                        request.deny();
                        return;
                    }
                    boolean granted = true;
                    for (String permission : androidPermissions) {
                        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) granted = false;
                    }
                    if (granted) {
                        request.grant(resources);
                    } else {
                        pendingWebPermissionRequest = request;
                        requestPermissions(androidPermissions.toArray(new String[0]), 5201);
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                runOnUiThread(() -> {
                    boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                    boolean coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                    if (fine || coarse) {
                        callback.invoke(origin, true, false);
                    } else {
                        pendingGeoOrigin = origin;
                        pendingGeoCallback = callback;
                        requestPermissions(new String[] {
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        }, 5202);
                    }
                });
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (printWebView != null) {
                    printWebView.stopLoading();
                    printWebView.destroy();
                }
                printWebView = new WebView(MainActivity.this);
                WebSettings popupSettings = printWebView.getSettings();
                popupSettings.setJavaScriptEnabled(true);
                popupSettings.setDomStorageEnabled(true);
                popupSettings.setLoadsImagesAutomatically(true);
                popupSettings.setJavaScriptCanOpenWindowsAutomatically(true);
                popupSettings.setSupportMultipleWindows(false);
                printWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return handleExternalUrl(request.getUrl());
                    }
                });
                printWebView.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onCloseWindow(WebView window) {
                        closePrintWindow();
                    }
                });
                setContentView(printWebView);
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(printWebView);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "फाइल चुनें"), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "फाइल चुनने का विकल्प उपलब्ध नहीं है", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) request.addRequestHeader("Cookie", cookie);
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle("AJSF Online डाउनलोड");
                request.setDescription("फाइल डाउनलोड हो रही है");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType));
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
                Toast.makeText(MainActivity.this, "डाउनलोड शुरू हो गया है", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "डाउनलोड शुरू नहीं हो पाया", Toast.LENGTH_LONG).show();
            }
        });

        // Always fetch the current hosted app instead of restoring a stale WebView page.
        // clearCache() does not erase localStorage/IndexedDB, so queued app data is preserved.
        webView.clearCache(true);
        webView.clearHistory();
        webView.loadUrl(APP_URL + "&app_refresh=20261119-camera-signature");
    }


    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 5201 && pendingWebPermissionRequest != null) {
            PermissionRequest request = pendingWebPermissionRequest;
            pendingWebPermissionRequest = null;
            boolean granted = true;
            for (int result : grantResults) if (result != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) request.grant(request.getResources()); else request.deny();
        } else if (requestCode == 5202 && pendingGeoCallback != null) {
            boolean granted = false;
            for (int i = 0; i < permissions.length; i++) {
                if ((Manifest.permission.ACCESS_FINE_LOCATION.equals(permissions[i]) ||
                     Manifest.permission.ACCESS_COARSE_LOCATION.equals(permissions[i])) &&
                     grantResults[i] == PackageManager.PERMISSION_GRANTED) granted = true;
            }
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    // Never let WebView try to load app-specific schemes such as whatsapp://.
    // Hand them to Android so the installed app can receive the deep link.
    private boolean handleExternalUrl(Uri uri) {
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) && APP_HOST.equalsIgnoreCase(uri.getHost())) return false;

        if ("whatsapp".equalsIgnoreCase(scheme) || "intent".equalsIgnoreCase(scheme)
                || "tel".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme)
                || "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                if ("whatsapp".equalsIgnoreCase(scheme)) {
                    intent.setPackage("com.whatsapp");
                    try {
                        startActivity(intent);
                    } catch (ActivityNotFoundException missingWhatsApp) {
                        intent.setPackage(null);
                        Uri fallback = buildWhatsAppWebFallback(uri);
                        if (fallback != null) startActivity(new Intent(Intent.ACTION_VIEW, fallback));
                        else Toast.makeText(this, "WhatsApp इंस्टॉल नहीं है", Toast.LENGTH_LONG).show();
                    }
                } else {
                    startActivity(intent);
                }
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, "इस लिंक को खोलने के लिए ऐप उपलब्ध नहीं है", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return true;
    }

    private Uri buildWhatsAppWebFallback(Uri original) {
        String phone = original.getQueryParameter("phone");
        String message = original.getQueryParameter("text");
        if (phone == null || phone.trim().isEmpty()) return null;
        return new Uri.Builder().scheme("https").authority("wa.me")
                .appendPath(phone.replaceAll("[^0-9]", ""))
                .appendQueryParameter("text", message == null ? "" : message)
                .build();
    }

    private class AjsfDownloadBridge {
        @JavascriptInterface
        public String saveBase64(String base64, String fileName, String mimeType) {
            try {
                if (android.os.Build.VERSION.SDK_INT < 29) {
                    return "इस Android version में सुरक्षित Downloads save उपलब्ध नहीं है।";
                }
                String safeName = (fileName == null ? "AJSF-Receipt.pdf" : fileName)
                        .replaceAll("[^A-Za-z0-9._-]", "_");
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE,
                        mimeType == null ? "application/pdf" : mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AJSF Receipts");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "Downloads में फाइल बनाने में समस्या हुई।";
                try (OutputStream output = getContentResolver().openOutputStream(uri)) {
                    if (output == null) throw new IllegalStateException("फाइल नहीं खुली");
                    output.write(bytes);
                    output.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Receipt Downloads/AJSF Receipts में सेव हो गई", Toast.LENGTH_LONG).show());
                return "OK";
            } catch (Exception e) {
                return "PDF सेव नहीं हो पाई: " + e.getMessage();
            }
        }
    }

    private class AjsfPrintBridge {
        @JavascriptInterface
        public void print(String jobName) {
            runOnUiThread(() -> {
                if (webView == null) return;
                try {
                    PrintManager printManager = (PrintManager) getSystemService(PRINT_SERVICE);
                    String safeName = (jobName == null || jobName.trim().isEmpty())
                            ? "AJSF Receipt" : jobName.trim();
                    PrintAttributes attributes = new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS).build();
                    printManager.print(safeName, webView.createPrintDocumentAdapter(safeName), attributes);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Print Settings नहीं खुल पाईं: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void closePrintWindow() {
        if (printWebView != null) {
            printWebView.stopLoading();
            printWebView.destroy();
            printWebView = null;
        }
        if (webView != null) setContentView(webView);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (printWebView != null) {
            closePrintWindow();
            return;
        }
        if (webView == null) {
            moveTaskToBack(true);
            return;
        }
        webView.evaluateJavascript(
                "(function() {" +
                " var panel = document.getElementById('receiptPanel');" +
                " if (panel && !panel.classList.contains('hidden')) {" +
                "   panel.classList.add('hidden');" +
                "   var form = document.getElementById('paymentForm');" +
                "   var section = form ? form.closest('section') : panel.previousElementSibling;" +
                "   if (section) section.scrollIntoView({behavior:'smooth', block:'start'});" +
                "   return true;" +
                " }" +
                " return false;" +
                "})()",
                value -> {
                    if (webView != null && !"true".equals(value)) moveTaskToBack(true);
                }
        );
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) filePathCallback.onReceiveValue(null);
        if (printWebView != null) {
            printWebView.stopLoading();
            printWebView.destroy();
            printWebView = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
