package io.cryptoworm.wars;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Crypto Worm Wars for Android: a full-screen WebView around the live game at
 * play.cryptoworm.io. Game pages stay inside the app; every other link (Telegram,
 * X, wallet apps, Stars payments) opens in the app that handles it.
 */
public class MainActivity extends Activity {

    private static final String HOST = "play.cryptoworm.io";
    private static final String START_URL = "https://" + HOST + "/?src=android";
    private static final int FILE_PICK = 7;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(13, 16, 48));
        setContentView(web);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " CryptoWormApp/android");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleUrl(req.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // window.open(...) from the game: read the URL from a throwaway view and route it.
            @Override
            public boolean onCreateWindow(WebView view, boolean dialog, boolean user, Message msg) {
                WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        Uri u = req.getUrl();
                        if (isGame(u)) web.loadUrl(u.toString()); else openOutside(u);
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) msg.obj).setWebView(tmp);
                msg.sendToTarget();
                return true;
            }

            // Photo upload (Custom Worm and similar).
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), FILE_PICK);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrl(getIntent()));
    }

    private String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && isGame(data)) {
            String u = data.toString();
            if (data.getQueryParameter("src") == null) u += (u.contains("?") ? "&" : "?") + "src=android";
            return u;
        }
        return START_URL;
    }

    private static boolean isGame(Uri u) {
        return u != null && "https".equals(u.getScheme()) && HOST.equalsIgnoreCase(u.getHost());
    }

    private boolean handleUrl(Uri u) {
        if (isGame(u)) return false;
        openOutside(u);
        return true;
    }

    private void openOutside(Uri u) {
        try {
            Intent i;
            if ("intent".equals(u.getScheme())) {
                i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
            } else {
                i = new Intent(Intent.ACTION_VIEW, u);
            }
            startActivity(i);
        } catch (Exception e) {
            // No app for this link (for example a wallet that is not installed).
        }
    }

    private void showOffline() {
        String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'></head>"
            + "<body style='background:#0d1030;color:#fff;font-family:sans-serif;text-align:center;padding-top:30vh'>"
            + "<h2>No connection</h2><p>Crypto Worm Wars needs the internet.</p>"
            + "<button style='font-size:20px;padding:12px 28px;border-radius:12px;border:0;background:#f5c542'"
            + " onclick=\"location.href='" + START_URL + "'\">Try again</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void hideSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(true);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) hideSystemBars();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null && isGame(intent.getData())) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == FILE_PICK && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
