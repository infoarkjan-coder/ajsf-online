package com.arkjansamriddhi.ajsf;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
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

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 701;
    private static final int FILE_CHOOSER_REQUEST = 702;
    private static final String HOME = "https://ajsf-online.vercel.app/?platform=app";
    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingWebPermission;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildScreen();
        configureWebView();
        if (state == null) webView.loadUrl(HOME);
        else webView.restoreState(state);
    }

    private void buildScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 5));
        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
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
                boolean needsCamera = false, needsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needsCamera = true;
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsAudio = true;
                }
                if ((!needsCamera || granted(Manifest.permission.CAMERA)) &&
                    (!needsAudio || granted(Manifest.permission.RECORD_AUDIO))) {
                    request.grant(request.getResources());
                } else {
                    pendingWebPermission = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO},
                        PERMISSION_REQUEST);
                }
            }

            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (granted(Manifest.permission.ACCESS_FINE_LOCATION) ||
                    granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
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
        if (pendingWebPermission != null) {
            boolean ok = true;
            for (String resource : pendingWebPermission.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && !granted(Manifest.permission.CAMERA)) ok = false;
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && !granted(Manifest.permission.RECORD_AUDIO)) ok = false;
            }
            if (ok) pendingWebPermission.grant(pendingWebPermission.getResources());
            else pendingWebPermission.deny();
            pendingWebPermission = null;
        }
        if (pendingGeoCallback != null) {
            boolean ok = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
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
        webView.saveState(out);
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
