package com.arkjansamriddhi.ajsf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AJSFLocationService extends Service {
    private static final String TAG = "AJSFLocationService";
    private static final String CHANNEL_ID = "ajsf_duty_location";
    private static final int NOTIFICATION_ID = 7301;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private LocationManager locationManager;
    private LocationListener listener;
    private String accessToken;
    private String apiKey;
    private String supabaseUrl;

    @Override public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        accessToken = intent.getStringExtra("access_token");
        apiKey = intent.getStringExtra("api_key");
        supabaseUrl = intent.getStringExtra("supabase_url");
        if (accessToken == null || apiKey == null || supabaseUrl == null) {
            stopSelf(); return START_NOT_STICKY;
        }
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        beginUpdates();
        return START_STICKY;
    }

    private void beginUpdates() {
        try {
            if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                stopSelf(); return;
            }
            listener = new LocationListener() {
                @Override public void onLocationChanged(Location location) { sendLocation(location); }
                @Override public void onProviderEnabled(String provider) { }
                @Override public void onProviderDisabled(String provider) { }
                @Deprecated @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
            };
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 30000L, 25f, listener, Looper.getMainLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 60000L, 50f, listener, Looper.getMainLooper());
            }
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last != null) sendLocation(last);
        } catch (SecurityException error) {
            Log.w(TAG, "Location permission unavailable", error);
            stopSelf();
        } catch (Exception error) {
            Log.e(TAG, "Unable to start location updates", error);
            stopSelf();
        }
    }

    private void sendLocation(Location location) {
        if (location == null || accessToken == null) return;
        final double lat = location.getLatitude();
        final double lon = location.getLongitude();
        final float accuracy = location.hasAccuracy() ? location.getAccuracy() : -1f;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(supabaseUrl.replaceAll("/+$", "") + "/rest/v1/rpc/ajs_record_duty_location");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("apikey", apiKey);
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
                String accuracyJson = accuracy < 0 ? "null" : Float.toString(accuracy);
                String body = "{\"p_latitude\":" + lat + ",\"p_longitude\":" + lon + ",\"p_accuracy_m\":" + accuracyJson + "}";
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) Log.w(TAG, "Location update rejected: HTTP " + status);
            } catch (Exception error) {
                Log.w(TAG, "Location upload failed; next GPS update will retry", error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "AJSF Duty Location", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("जब कर्मचारी Duty पर हो तभी AJSF लोकेशन अपडेट करता है।");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setContentTitle("AJSF Duty Tracking चालू है")
            .setContentText("Duty End करने तक आपकी लोकेशन सुरक्षित रूप से अपडेट होगी।")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build();
    }

    @Override public void onDestroy() {
        if (locationManager != null && listener != null) {
            try { locationManager.removeUpdates(listener); } catch (SecurityException ignored) { }
        }
        accessToken = null;
        network.shutdown();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
