package ai.kivo.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

/**
 * kivo — Android shell.
 *
 * The whole product is a phone-first web app served by the kivo backend, so the
 * native side is deliberately thin and has zero dependencies (no AndroidX, no
 * Kotlin, no third-party SDK). What it adds on top of a browser:
 *
 *   - a launcher icon and an app entry that points at your kivo server;
 *   - the runtime permissions the report scanner (getUserMedia → camera) and
 *     voice journaling (microphone) need, granted to the WebView;
 *   - a file chooser so the "upload from gallery" fallback works;
 *   - a first-run screen for the server address, with the phone's own LAN IPs
 *     shown so the "which address do I type?" question answers itself;
 *   - honest error screens (host not found / refused / TLS rejected) instead of
 *     a blank page — this is a demo that has to survive a hotel Wi-Fi;
 *   - a menu that switches between the three surfaces the backend serves
 *     (/m/ phone app, /app/ dashboard, /doctor/ console) without reinstalling.
 *
 * The page is loaded from the server rather than bundled into the APK on
 * purpose: the web app calls `/api/...` with relative URLs, registers a service
 * worker and shares one origin with its assets. Loading it from the server keeps
 * all of that working and means a frontend change never needs a new APK.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "kivo_prefs";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_SURFACE = "surface";

    /** The three frontends the backend serves. `/m/` is the phone-first one. */
    private static final String SURFACE_PHONE = "/m/";
    private static final String SURFACE_DASHBOARD = "/app/";
    private static final String SURFACE_DOCTOR = "/doctor/";

    private static final int REQ_FILE_CHOOSER = 4201;
    private static final int REQ_RUNTIME_PERMS = 4202;

    private WebView webView;
    private View setupPanel;
    private View errorPanel;
    private ProgressBar progressBar;
    private EditText serverInput;
    private TextView barTitle;
    private TextView barServer;
    private TextView errorDetail;
    private TextView setupHint;

    private SharedPreferences prefs;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingPermissionRequest;

    private String currentServer = "";
    private String currentSurface = SURFACE_PHONE;

    /* ------------------------------------------------------------------ */
    /* lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        barTitle = findViewById(R.id.bar_title);
        barServer = findViewById(R.id.bar_server);
        progressBar = findViewById(R.id.progress);
        webView = findViewById(R.id.web);
        setupPanel = findViewById(R.id.setup_panel);
        errorPanel = findViewById(R.id.error_panel);
        errorDetail = findViewById(R.id.error_detail);
        serverInput = findViewById(R.id.setup_server_input);
        setupHint = findViewById(R.id.setup_hint);

        ImageButton menuButton = findViewById(R.id.btn_menu);
        menuButton.setOnClickListener(this::showMenu);
        findViewById(R.id.btn_connect).setOnClickListener(v -> connectFromInput());
        findViewById(R.id.btn_retry).setOnClickListener(v -> reload());
        findViewById(R.id.btn_change_server).setOnClickListener(v -> showSetup());

        configureWebView();
        showLanHint();

        String savedServer = prefs.getString(KEY_SERVER, "");
        currentSurface = prefs.getString(KEY_SURFACE, SURFACE_PHONE);
        if (TextUtils.isEmpty(savedServer)) {
            showSetup();
        } else {
            serverInput.setText(savedServer);
            start(savedServer, currentSurface);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ */
    /* webview setup                                                       */
    /* ------------------------------------------------------------------ */

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);      // session tokens live in localStorage
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);   // voice journal, video shorts
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setTextZoom(100);
        // Only https origins are ever loaded, so file access stays off.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        // Identify the shell in server logs without hiding the real WebView UA.
        settings.setUserAgentString(settings.getUserAgentString() + " kivo-android/" + versionName());

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Remote debugging in a debug build only — never in the shipped APK.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new KivoBridge(), "KivoNative");
        webView.setWebViewClient(new KivoWebViewClient());
        webView.setWebChromeClient(new KivoChromeClient());
        webView.setBackgroundColor(0xFFF6F7F7);

        // Anything the web app hands to the browser (an APK download, an export)
        // goes to the real browser instead of vanishing.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (!TextUtils.isEmpty(url)) {
                openExternal(Uri.parse(url));
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* navigation                                                          */
    /* ------------------------------------------------------------------ */

    private void connectFromInput() {
        String server = normalizeServer(serverInput.getText() == null ? "" : serverInput.getText().toString());
        if (server == null) {
            toast(getString(R.string.err_invalid_url));
            if (serverInput != null) {
                serverInput.requestFocus();
            }
            return;
        }
        if (isLoopback(server)) {
            // The most common demo mistake: on a phone, localhost is the phone.
            toast(getString(R.string.warn_loopback));
        }
        hideKeyboard();
        start(server, currentSurface);
    }

    private void start(String rawServer, String surface) {
        String server = normalizeServer(rawServer);
        if (server == null) {
            toast(getString(R.string.err_invalid_url));
            showSetup();
            return;
        }
        String path = normalizeSurface(surface);

        currentServer = server;
        currentSurface = path;
        prefs.edit().putString(KEY_SERVER, server).putString(KEY_SURFACE, path).apply();

        errorPanel.setVisibility(View.GONE);
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        updateBar();
        webView.loadUrl(server + path);
    }

    private void reload() {
        if (TextUtils.isEmpty(currentServer)) {
            showSetup();
            return;
        }
        webView.reload();
    }

    private void showSetup() {
        setupPanel.setVisibility(View.VISIBLE);
        errorPanel.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        showLanHint();
        if (serverInput != null) {
            serverInput.requestFocus();
        }
    }

    private void showError(String detail) {
        runOnUiThread(() -> {
            if (errorDetail != null) {
                errorDetail.setText(detail);
            }
            errorPanel.setVisibility(View.VISIBLE);
            setupPanel.setVisibility(View.GONE);
        });
    }

    private void updateBar() {
        if (barServer == null) {
            return;
        }
        barServer.setText(getString(R.string.bar_server, hostOf(currentServer), currentSurface));
    }

    private static String hostOf(String server) {
        try {
            String host = Uri.parse(server).getHost();
            if (!TextUtils.isEmpty(host)) {
                int port = Uri.parse(server).getPort();
                return port > 0 ? host + ":" + port : host;
            }
        } catch (Exception ignored) {
            // fall through to the raw string
        }
        return server;
    }

    /* ------------------------------------------------------------------ */
    /* server address helpers                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Turns "192.168.1.7:8080" or "http://192.168.1.7:8080/" into a clean
     * "http://192.168.1.7:8080". Returns null when the input is unusable.
     */
    static String normalizeServer(String raw) {
        String value = raw == null ? "" : raw.trim().replaceAll("\\s+", "");
        if (value.isEmpty()) {
            return null;
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception e) {
            return null;
        }
        if (TextUtils.isEmpty(uri.getHost())) {
            return null;
        }
        String result = uri.toString();
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    /** Anything unrecognised falls back to the phone app. */
    static String normalizeSurface(String surface) {
        if (SURFACE_DASHBOARD.equals(surface) || SURFACE_DOCTOR.equals(surface)) {
            return surface;
        }
        return SURFACE_PHONE;
    }

    private static boolean isLoopback(String server) {
        String host;
        try {
            host = Uri.parse(server).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null) {
            return false;
        }
        host = host.toLowerCase();
        return host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("[::1]");
    }

    /** The phone's own Wi-Fi IPs, so the user knows which subnet to type. */
    private void showLanHint() {
        if (setupHint == null) {
            return;
        }
        String ips = lanAddresses();
        setupHint.setText(TextUtils.isEmpty(ips)
                ? getString(R.string.setup_hint)
                : getString(R.string.setup_hint_with_ips, ips));
    }

    private static String lanAddresses() {
        StringBuilder found = new StringBuilder();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                if (networkInterface.isLoopback() || !networkInterface.isUp()) {
                    continue;
                }
                for (InterfaceAddress address : networkInterface.getInterfaceAddresses()) {
                    InetAddress inet = address.getAddress();
                    if (inet instanceof Inet4Address && inet.isSiteLocalAddress()) {
                        if (found.length() > 0) {
                            found.append("   ");
                        }
                        found.append(inet.getHostAddress());
                    }
                }
            }
        } catch (Exception e) {
            return "";
        }
        return found.toString();
    }

    /* ------------------------------------------------------------------ */
    /* menu                                                                */
    /* ------------------------------------------------------------------ */

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenuInflater().inflate(R.menu.main_menu, menu.getMenu());
        menu.setOnMenuItemClickListener(item -> {
            int id = item.getItemId();
            if (id == R.id.action_reload) {
                reload();
            } else if (id == R.id.action_surface_phone) {
                openSurface(SURFACE_PHONE);
            } else if (id == R.id.action_surface_dashboard) {
                openSurface(SURFACE_DASHBOARD);
            } else if (id == R.id.action_surface_doctor) {
                openSurface(SURFACE_DOCTOR);
            } else if (id == R.id.action_change_server) {
                showSetup();
            } else if (id == R.id.action_open_browser) {
                if (TextUtils.isEmpty(currentServer)) {
                    toast(getString(R.string.err_invalid_url));
                } else {
                    openExternal(Uri.parse(currentServer + currentSurface));
                }
            } else if (id == R.id.action_about) {
                showAbout();
            } else {
                return false;
            }
            return true;
        });
        menu.show();
    }

    private void openSurface(String surface) {
        if (TextUtils.isEmpty(currentServer)) {
            showSetup();
            return;
        }
        start(currentServer, surface);
    }

    private void showAbout() {
        String webviewVersion = "";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
                if (info != null) {
                    webviewVersion = info.versionName;
                }
            } catch (Exception ignored) {
                // cosmetic — the dialog is still useful without it
            }
        }
        String message = getString(
                R.string.about_body,
                getPackageName(),
                versionName(),
                versionCode(),
                TextUtils.isEmpty(currentServer) ? getString(R.string.about_no_server) : currentServer,
                currentSurface,
                TextUtils.isEmpty(webviewVersion) ? getString(R.string.about_unknown) : webviewVersion);
        new AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setMessage(message)
                .setPositiveButton(R.string.close, null)
                .show();
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return BuildConfig.VERSION_NAME;
        }
    }

    private String versionCode() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return String.valueOf(info.getLongVersionCode());
            }
            return String.valueOf(info.versionCode);
        } catch (Exception e) {
            return String.valueOf(BuildConfig.VERSION_CODE);
        }
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            toast(getString(R.string.err_no_browser));
        }
    }

    /* ------------------------------------------------------------------ */
    /* back button                                                         */
    /* ------------------------------------------------------------------ */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (errorPanel != null && errorPanel.getVisibility() == View.VISIBLE) {
                showSetup();
                return true;
            }
            if (webView != null && webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    /* ------------------------------------------------------------------ */
    /* runtime permissions (camera + microphone for the web app)           */
    /* ------------------------------------------------------------------ */

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_RUNTIME_PERMS) {
            return;
        }
        PermissionRequest request = pendingPermissionRequest;
        pendingPermissionRequest = null;
        if (request == null) {
            return;
        }
        List<String> granted = new ArrayList<>();
        for (int i = 0; i < permissions.length; i++) {
            boolean allowed = i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED;
            if (!allowed) {
                continue;
            }
            if (Manifest.permission.CAMERA.equals(permissions[i])) {
                granted.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            } else if (Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                granted.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
            }
        }
        try {
            if (granted.isEmpty()) {
                request.deny();
            } else {
                request.grant(granted.toArray(new String[granted.size()]));
            }
        } catch (Exception e) {
            // The WebView can go away while the system dialog is open.
            toast(getString(R.string.err_permission));
        }
    }

    /* ------------------------------------------------------------------ */
    /* file chooser (gallery fallback for the report scanner)              */
    /* ------------------------------------------------------------------ */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            ValueCallback<Uri[]> callback = filePathCallback;
            filePathCallback = null;
            if (callback != null) {
                callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ------------------------------------------------------------------ */
    /* small utilities                                                     */
    /* ------------------------------------------------------------------ */

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
    }

    private void hideKeyboard() {
        InputMethodManager manager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (manager != null && serverInput != null) {
            manager.hideSoftInputFromWindow(serverInput.getWindowToken(), 0);
        }
    }

    /* ------------------------------------------------------------------ */
    /* javascript bridge                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * Exposed to the page as `window.KivoNative`. The web app does not need it
     * today (it is loaded from the server, so relative `/api` calls just work),
     * but it lets the frontend detect the shell — hide the "download the APK"
     * buttons, or ask the user to change server — without sniffing the user
     * agent. Every method is annotated, which is what keeps the rest of the
     * class private to Java.
     */
    private final class KivoBridge {

        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        /** Absolute origin of the kivo backend, e.g. http://192.168.1.7:8080 */
        @JavascriptInterface
        public String apiBase() {
            return currentServer == null ? "" : currentServer;
        }

        @JavascriptInterface
        public String surface() {
            return currentSurface == null ? SURFACE_PHONE : currentSurface;
        }

        @JavascriptInterface
        public String appVersion() {
            return versionName();
        }

        /** Lets the web app surface a native toast. */
        @JavascriptInterface
        public void toast(String message) {
            if (!TextUtils.isEmpty(message)) {
                MainActivity.this.toast(message);
            }
        }

        /** Opens the server-address screen from inside the web app. */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(MainActivity.this::showSetup);
        }
    }

    /* ------------------------------------------------------------------ */
    /* WebViewClient                                                       */
    /* ------------------------------------------------------------------ */

    private final class KivoWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request == null ? null : request.getUrl();
            if (url == null) {
                return false;
            }
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
            if (scheme.equals("http") || scheme.equals("https")) {
                String host = url.getHost();
                String serverHost = "";
                try {
                    serverHost = Uri.parse(currentServer).getHost();
                } catch (Exception ignored) {
                    // currentServer can be empty before the first connect
                }
                if (host != null && host.equals(serverHost)) {
                    return false; // our own app: stay inside the shell
                }
                openExternal(url);  // anything else: real browser
                return true;
            }
            if (scheme.equals("about") || scheme.equals("blob") || scheme.equals("data")) {
                return false;
            }
            if (scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("sms")
                    || scheme.equals("geo") || scheme.equals("intent")) {
                openExternal(url);
                return true;
            }
            return true; // unknown schemes are not ours to handle
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (progressBar != null) {
                progressBar.setVisibility(View.GONE);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame() || error == null) {
                return;
            }
            showError(describeError(error.getErrorCode(), error.getDescription()));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request == null || !request.isForMainFrame() || response == null) {
                return;
            }
            int status = response.getStatusCode();
            showError(status == 404
                    ? getString(R.string.err_http_404, currentServer + currentSurface)
                    : getString(R.string.err_http_generic, String.valueOf(status), currentServer + currentSurface));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Never proceed past a bad certificate: this shell points at a
            // backend that holds real health data.
            if (handler != null) {
                handler.cancel();
            }
            String code = error == null ? "unknown" : String.valueOf(error.getPrimaryError());
            showError(getString(R.string.err_ssl, code, currentServer));
        }

        private String describeError(int code, CharSequence description) {
            String what = description == null ? "" : description.toString();
            String target = TextUtils.isEmpty(currentServer) ? "" : currentServer;
            switch (code) {
                case WebViewClient.ERROR_HOST_LOOKUP:
                    return getString(R.string.err_host_lookup, target);
                case WebViewClient.ERROR_CONNECT:
                case WebViewClient.ERROR_IO:
                    return getString(R.string.err_connect, target, what);
                case WebViewClient.ERROR_TIMEOUT:
                    return getString(R.string.err_timeout, target);
                case WebViewClient.ERROR_FAILED_SSL_HANDSHAKE:
                    return getString(R.string.err_ssl, "handshake", target);
                default:
                    return getString(R.string.err_generic, String.valueOf(code), target, what);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* WebChromeClient                                                     */
    /* ------------------------------------------------------------------ */

    private final class KivoChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (progressBar == null) {
                return;
            }
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (barTitle != null && !TextUtils.isEmpty(title)) {
                barTitle.setText(title);
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            if (request == null) {
                return;
            }
            runOnUiThread(() -> {
                String[] wanted = request.getResources();
                boolean needsCamera = false;
                boolean needsMic = false;
                if (wanted != null) {
                    for (String resource : wanted) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            needsCamera = true;
                        } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            needsMic = true;
                        }
                    }
                }

                List<String> missing = new ArrayList<>();
                if (needsCamera && checkSelfPermission(Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.CAMERA);
                }
                if (needsMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.RECORD_AUDIO);
                }

                if (missing.isEmpty()) {
                    try {
                        request.grant(wanted == null ? new String[0] : wanted);
                    } catch (Exception e) {
                        toast(getString(R.string.err_permission));
                    }
                    return;
                }

                pendingPermissionRequest = request;
                requestPermissions(missing.toArray(new String[missing.size()]), REQ_RUNTIME_PERMS);
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;

            Intent picker = new Intent(Intent.ACTION_GET_CONTENT);
            picker.addCategory(Intent.CATEGORY_OPENABLE);
            String[] mimes = acceptedMimeTypes(params);
            picker.setType(mimes.length == 0 ? "*/*" : mimes[0]);
            if (mimes.length > 0) {
                picker.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
            }

            try {
                startActivityForResult(
                        Intent.createChooser(picker, getString(R.string.choose_file)),
                        REQ_FILE_CHOOSER);
            } catch (Exception e) {
                filePathCallback = null;
                if (callback != null) {
                    callback.onReceiveValue(null);
                }
                toast(getString(R.string.err_no_picker));
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
            // Web console noise must never become a native problem.
            return true;
        }

        /** `<input type="file" accept="…">` → the mime types the picker offers. */
        private String[] acceptedMimeTypes(FileChooserParams params) {
            if (params == null || params.getAcceptTypes() == null) {
                return new String[0];
            }
            List<String> mimes = new ArrayList<>();
            for (String type : params.getAcceptTypes()) {
                if (TextUtils.isEmpty(type)) {
                    continue;
                }
                String cleaned = type.trim();
                if (cleaned.startsWith(".")) {
                    cleaned = mimeForExtension(cleaned);
                }
                if (cleaned.contains("/") && !mimes.contains(cleaned)) {
                    mimes.add(cleaned);
                }
            }
            return mimes.toArray(new String[mimes.size()]);
        }

        private String mimeForExtension(String extension) {
            switch (extension.toLowerCase()) {
                case ".jpg":
                case ".jpeg":
                    return "image/jpeg";
                case ".png":
                    return "image/png";
                case ".webp":
                    return "image/webp";
                case ".heic":
                    return "image/heic";
                case ".pdf":
                    return "application/pdf";
                default:
                    return "*/*";
            }
        }
    }
}
