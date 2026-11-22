package com.arkjansamriddhi.ajsf;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 701;
    private static final int FILE_CHOOSER_REQUEST = 702;
    private static final String HOME = "https://ajsf-online.vercel.app/?platform=app";
    private static final String TRUSTED_HOST = "ajsf-online.vercel.app";
    private WebView webView;
    private WebView printWebView;
    private PrintJob activePrintJob;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingCameraRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final Map<String, Uri> pendingDownloadUris = new HashMap<>();
    private final Map<String, OutputStream> pendingDownloadStreams = new HashMap<>();

    private boolean isTrustedOrigin(String origin) {
        try {
            Uri uri = Uri.parse(origin);
            return "https".equalsIgnoreCase(uri.getScheme())
                && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildScreen();
        configureWebView();
        if (state == null) webView.loadUrl(HOME);
        else if (webView.restoreState(state) == null) webView.loadUrl(HOME);
    }

    private void buildScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 5));
        webView = new WebView(this);
        webView.addJavascriptInterface(new AJSFNativeDownload(), "AJSFNativeDownload");
        webView.addJavascriptInterface(new AJSFNativeTracking(), "AJSFNativeTracking");
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (request.isForMainFrame() && isTrustedOrigin(uri.toString())) return false;
                if (request.isForMainFrame()) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (Exception ignored) { }
                }
                return true;
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showConnectionError();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!isTrustedOrigin(request.getOrigin().toString())) {
                        request.deny();
                        return;
                    }
                    String[] resources = request.getResources();
                    boolean cameraOnly = resources.length > 0;
                    for (String resource : resources) {
                        if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) cameraOnly = false;
                    }
                    if (!cameraOnly) {
                        request.deny();
                    } else if (granted(Manifest.permission.CAMERA)) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        pendingCameraRequest = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, PERMISSION_REQUEST);
                    }
                });
            }

            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!isTrustedOrigin(origin)) {
                    callback.invoke(origin, false, false);
                } else if (granted(Manifest.permission.ACCESS_FINE_LOCATION)
                        || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, PERMISSION_REQUEST);
                }
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "AJSF में फ़ाइल चुनें"), FILE_CHOOSER_REQUEST);
                } catch (Exception ex) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }



    private final class AJSFNativeTracking {
        @JavascriptInterface
        public String startTracking(String accessToken, String apiKey, String supabaseUrl) {
            if (accessToken == null || accessToken.isEmpty() || apiKey == null || apiKey.isEmpty()
                    || supabaseUrl == null || !supabaseUrl.startsWith("https://")) return "Tracking credentials उपलब्ध नहीं हैं।";
            if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)
                    && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) return "GPS अनुमति नहीं मिली। पहले लोकेशन अनुमति दें।";
            if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 704));
            }
            Intent service = new Intent(MainActivity.this, AJSFLocationService.class);
            service.putExtra("access_token", accessToken);
            service.putExtra("api_key", apiKey);
            service.putExtra("supabase_url", supabaseUrl);
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
                else startService(service);
                return "OK";
            } catch (Exception error) { return "Tracking service शुरू नहीं हुई: " + error.getMessage(); }
        }

        @JavascriptInterface
        public void stopTracking() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, AJSFLocationService.class)));
        }
    }

    private final class AJSFNativeDownload {
        @JavascriptInterface
        public String printHtml(String title, String content, String pageCss) {
            if (webView == null || !isTrustedOrigin(webView.getUrl())) return "Print केवल AJSF वेबसाइट से शुरू हो सकता है।";
            if (content == null || content.trim().isEmpty()) return "Print करने के लिए रिपोर्ट खाली है।";
            runOnUiThread(() -> startNativePrint(title, content, pageCss));
            return "OK";
        }

        @JavascriptInterface
        public synchronized String beginSave(String fileName, String mimeType) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "इस Android संस्करण में Downloads सेव सुविधा उपलब्ध नहीं है।";
            try {
                String safeName = (fileName == null ? "AJSF-Document.pdf" : fileName).replaceAll("[^A-Za-z0-9._-]", "_");
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType == null ? "application/pdf" : mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AJSF Online");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "Downloads में फ़ाइल बनाने में समस्या हुई।";
                OutputStream output = getContentResolver().openOutputStream(uri);
                if (output == null) {
                    getContentResolver().delete(uri, null, null);
                    return "फ़ाइल लिखने के लिए स्ट्रीम नहीं मिली।";
                }
                String token = UUID.randomUUID().toString();
                pendingDownloadUris.put(token, uri);
                pendingDownloadStreams.put(token, output);
                return token;
            } catch (Exception error) { return "फ़ाइल सेव शुरू नहीं हुई: " + error.getMessage(); }
        }

        @JavascriptInterface
        public synchronized String appendChunk(String token, String encodedChunk) {
            try {
                OutputStream output = pendingDownloadStreams.get(token);
                if (output == null) return "Download session नहीं मिली।";
                output.write(Base64.decode(encodedChunk, Base64.DEFAULT));
                return "OK";
            } catch (Exception error) { return "PDF डेटा सेव नहीं हुआ: " + error.getMessage(); }
        }

        @JavascriptInterface
        public synchronized String finishSave(String token) {
            Uri uri = pendingDownloadUris.get(token);
            OutputStream output = pendingDownloadStreams.get(token);
            if (uri == null || output == null) return "Download session पूरी नहीं मिली।";
            try {
                output.flush();
                output.close();
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, ready, null, null);
                pendingDownloadUris.remove(token);
                pendingDownloadStreams.remove(token);
                return "OK";
            } catch (Exception error) {
                try { output.close(); } catch (Exception ignored) { }
                getContentResolver().delete(uri, null, null);
                pendingDownloadUris.remove(token);
                pendingDownloadStreams.remove(token);
                return "PDF पूरी सेव नहीं हुई: " + error.getMessage();
            }
        }

        @JavascriptInterface
        public synchronized void cancelSave(String token) {
            OutputStream output = pendingDownloadStreams.remove(token);
            Uri uri = pendingDownloadUris.remove(token);
            try { if (output != null) output.close(); } catch (Exception ignored) { }
            if (uri != null) getContentResolver().delete(uri, null, null);
        }

        @JavascriptInterface
        public String saveBase64(String encoded, String fileName, String mimeType) {
            String token = beginSave(fileName, mimeType);
            if (token == null || token.isEmpty() || token.startsWith("फ़ाइल") || token.startsWith("Downloads") || token.startsWith("इस Android")) return token;
            try {
                for (int i = 0; i < encoded.length(); i += 65536) {
                    String result = appendChunk(token, encoded.substring(i, Math.min(i + 65536, encoded.length())));
                    if (!"OK".equals(result)) { cancelSave(token); return result; }
                }
                return finishSave(token);
            } catch (Exception error) { cancelSave(token); return "PDF सेव नहीं हुई: " + error.getMessage(); }
        }
    }

    private void startNativePrint(String title, String content, String pageCss) {
        if (isFinishing() || isDestroyed()) return;
        try {
            if (printWebView != null) {
                printWebView.stopLoading();
                printWebView.destroy();
                printWebView = null;
            }
            printWebView = new WebView(this);
            WebSettings printSettings = printWebView.getSettings();
            printSettings.setJavaScriptEnabled(false);
            printSettings.setDomStorageEnabled(false);
            printSettings.setAllowFileAccess(false);
            String safeTitle = title == null ? "AJSF Report" : title.replaceAll("[<>]", "");
            String html = "<!doctype html><html lang='en'><head><meta charset='utf-8'>" +
                "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
                "<base href='https://ajsf-online.vercel.app/'>" +
                "<title>" + safeTitle + "</title><style>" +
                "*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#172923;font-family:Arial,sans-serif}" +
                "body{padding:7mm;font-size:10pt;line-height:1.35}" +
                "img{max-width:100%;object-fit:contain}table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{break-inside:avoid}" +
                "th,td{border:1px solid #cbd8d0;padding:6px;text-align:left;vertical-align:top}th{background:#edf5f0;color:#23483c}" +
                "h1,h2,h3{color:#123f35}small{color:#60756b}" + (pageCss == null ? "" : pageCss) +
                "@media print{body{padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}" +
                "</style></head><body>" + content + "</body></html>";
            printWebView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    view.postDelayed(() -> {
                        if (isFinishing() || isDestroyed() || view != printWebView) return;
                        try {
                            PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
                            if (manager == null) throw new IllegalStateException("Android Print सेवा उपलब्ध नहीं है।");
                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(safeTitle);
                            activePrintJob = manager.print(safeTitle, adapter,
                                new PrintAttributes.Builder()
                                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                    .build());
                        } catch (Exception error) {
                            new AlertDialog.Builder(MainActivity.this)
                                .setTitle("AJSF Print")
                                .setMessage("Print शुरू नहीं हो पाया: " + error.getMessage())
                                .setPositiveButton("ठीक है", null).show();
                        }
                    }, 500);
                }
            });
            printWebView.loadDataWithBaseURL("https://ajsf-online.vercel.app/", html, "text/html", "UTF-8", null);
        } catch (Exception error) {
            new AlertDialog.Builder(this).setTitle("AJSF Print")
                .setMessage("Print तैयार नहीं हो पाया: " + error.getMessage())
                .setPositiveButton("ठीक है", null).show();
        }
    }

    private void showConnectionError() {
        new AlertDialog.Builder(this).setTitle("AJSF Online कनेक्शन")
            .setMessage("वेबसाइट से कनेक्शन नहीं हो पाया। इंटरनेट जाँचें और दोबारा प्रयास करें।")
            .setCancelable(false)
            .setPositiveButton("फिर से खोलें", (d, w) -> webView.loadUrl(HOME))
            .setNegativeButton("बंद करें", (d, w) -> finish()).show();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != PERMISSION_REQUEST) return;
        if (pendingCameraRequest != null) {
            if (granted(Manifest.permission.CAMERA)
                    && isTrustedOrigin(pendingCameraRequest.getOrigin().toString())) {
                pendingCameraRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pendingCameraRequest.deny();
            }
            pendingCameraRequest = null;
        }
        if (pendingGeoCallback != null) {
            boolean ok = isTrustedOrigin(pendingGeoOrigin)
                && (granted(Manifest.permission.ACCESS_FINE_LOCATION)
                    || granted(Manifest.permission.ACCESS_COARSE_LOCATION));
            pendingGeoCallback.invoke(pendingGeoOrigin, ok, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] result = resultCode == RESULT_OK && data != null && data.getData() != null
                ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (webView != null) webView.saveState(out);
    }

    @Override public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
            "(function(){return window.ajsfHandleAndroidBack ? window.ajsfHandleAndroidBack() : false;})()",
            value -> {
                if (!"true".equals(value)) MainActivity.super.onBackPressed();
            }
        );
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}