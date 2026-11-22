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

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 701;
    private static final int FILE_CHOOSER_REQUEST = 702;
    private static final String HOME = "https://ajsf-online.vercel.app/?platform=app";
    private static final String TRUSTED_HOST = "ajsf-online.vercel.app";
    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingCameraRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

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


    private final class AJSFNativeDownload {
        @JavascriptInterface
        public String saveBase64(String encoded, String fileName, String mimeType) {
            if (encoded == null || encoded.isEmpty() || fileName == null || fileName.isEmpty()) {
                return "PDF डेटा या फ़ाइल नाम खाली है।";
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                return "इस Android संस्करण में सुरक्षित Downloads सेव सुविधा उपलब्ध नहीं है। कृपया ब्राउज़र से डाउनलोड करें।";
            }
            try {
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                String safeName = fileName.replaceAll("[^A-Za-z0-9._-]", "_");
                if (!safeName.toLowerCase().endsWith(".pdf") && "application/pdf".equals(mimeType)) safeName += ".pdf";
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType == null ? "application/octet-stream" : mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AJSF Online");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "Downloads में फ़ाइल बनाने में समस्या हुई।";
                try (OutputStream output = getContentResolver().openOutputStream(uri)) {
                    if (output == null) throw new IllegalStateException("फ़ाइल लिखने के लिए स्ट्रीम नहीं मिली।");
                    output.write(bytes);
                    output.flush();
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, ready, null, null);
                return "OK";
            } catch (Exception error) {
                return "फ़ाइल सेव नहीं हुई: " + error.getMessage();
            }
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