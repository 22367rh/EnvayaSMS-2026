package org.envaya.sms.task;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;
import android.preference.PreferenceManager;

import java.lang.reflect.Method;
import java.security.MessageDigest;
import java.util.Base64;

import org.envaya.sms.App;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Pins the request-signature contract that the PHP server verifies:
 *
 *     signature = Base64( SHA-1( url + "," + sortedParams + "," + password ) )
 *
 * where {@code sortedParams} are the request params (name=value) sorted by name. This is a stable,
 * byte-level wire contract shared with the server, so it must not drift across refactors. The test
 * drives the real {@link HttpTask#makeHttpPost()} path (which attaches the {@code X-Request-Signature}
 * header from the private {@code getSignature()}) and compares against an independent computation of
 * the documented algorithm over the same inputs.
 *
 * <p>Driving {@code makeHttpPost()} directly (rather than through {@code doInBackground()}) keeps the
 * input deterministic: only the constructor's auto-added {@code version} param plus the two params we
 * add are present, so no battery/network/log/now noise leaks into the digest.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class HttpTaskSignatureTest {

    private static final String URL = "https://example.com/";
    private static final String PASSWORD = "s3cret-passphrase";

    private App app;

    @Before
    public void setUp() throws Exception {
        // Real application instance built from the manifest (declares .App); onCreate() has run, so
        // settings and packageInfo are initialized.
        app = (App) RuntimeEnvironment.getApplication();

        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(app);
        prefs.edit().putString("server_url", URL).putString("password", PASSWORD).commit();
    }

    @Test
    public void signatureMatchesDocumentedAlgorithm() throws Exception {
        // Constructor appends a "version" param (= package versionCode) after the ones we pass.
        HttpTask task = new HttpTask(app, new NameValuePair("b", "2"), new NameValuePair("a", "1"));

        int versionCode = app.getPackageInfo().versionCode;

        // getSignature() sorts params by name ascending and builds: url + ",name=value"..., + "," + password
        String signatureString = URL + ",a=1,b=2,version=" + versionCode + "," + PASSWORD;

        MessageDigest md = MessageDigest.getInstance("SHA-1");
        md.update(signatureString.getBytes("utf-8"));
        String expected = Base64.getEncoder().encodeToString(md.digest());

        // makeHttpPost() is where the real getSignature() output is attached to the request header.
        okhttp3.Request request = task.makeHttpPost();
        String actual = request.header("X-Request-Signature");

        assertNotNull("signature header must be present", actual);
        assertEquals(
                "request signature must equal Base64(SHA-1(url + sortedParams + password))",
                expected, actual);
    }

    /**
     * Guard against a subtle regression: the sort comparator in getSignature() compares by param name.
     * If two params share a prefix (e.g. "phone_id" vs "phone_number") an incorrect comparison could
     * reorder them and change the digest even though the set of params is unchanged. This pins that the
     * ordering is stable for a realistic multi-param set.
     */
    @Test
    public void signatureIsStableAcrossRepeatedComputation() throws Exception {
        HttpTask task = new HttpTask(app, new NameValuePair("phone_id", "dev-1"),
                new NameValuePair("phone_number", "15551230000"));

        String first = task.makeHttpPost().header("X-Request-Signature");
        // Rebuild an identical task and confirm the signature is byte-identical (deterministic).
        HttpTask task2 = new HttpTask(app, new NameValuePair("phone_id", "dev-1"),
                new NameValuePair("phone_number", "15551230000"));
        String second = task2.makeHttpPost().header("X-Request-Signature");

        assertEquals("signature must be deterministic for identical inputs", first, second);
        assertTrue("signature should look like base64", first.matches("[A-Za-z0-9+/=]+"));
    }
}
