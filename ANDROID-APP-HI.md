# AJSF Online Android App

यह Android wrapper मौजूदा production web app को Android WebView में खोलता है:
https://ajsf-online.vercel.app/

## Build
GitHub Actions में **Build AJSF Android APK** workflow चलाएँ। सफल build के बाद
**AJSF-Online-Android-APK** artifact से APK डाउनलोड किया जा सकता है।

## App details
- App name: AJSF Online
- Package ID: com.arkjan.ajsfonline
- Version: 1.0.0
- Minimum Android: 8.0 (API 26)
- Android app का डेटा मौजूदा Supabase backend में ही रहेगा।

## Important
यह पहला परीक्षण APK है। यह ऑनलाइन वेबसाइट को ऐप के अंदर खोलता है; यह native offline-first
collection engine नहीं है। Offline payment entry/sync, device-specific testing, blob-based
backup downloads और release signing को अलग से verify करना होगा। Debug APK केवल testing/
direct internal installation के लिए है; Play Store release के लिए सुरक्षित release keystore
और अलग signed build जरूरी होगा।
