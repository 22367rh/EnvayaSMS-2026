package org.envaya.sms;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertFalse;

import android.content.SharedPreferences;
import android.preference.PreferenceManager;
import android.provider.Settings;

import java.util.UUID;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AppIdentityTest {

    private App app;

    @Before
    public void setUp() {
        app = (App) RuntimeEnvironment.getApplication();
        PreferenceManager.getDefaultSharedPreferences(app).edit().clear().commit();
    }

    @Test
    public void initializesPhoneIdAndTokenOnFirstLaunch() {
        String testAndroidId = "1234567890abcdef";
        Settings.Secure.putString(app.getContentResolver(), Settings.Secure.ANDROID_ID, testAndroidId);

        // Call onCreate to trigger initialisation on launch
        app.onCreate();

        String phoneId = app.getPhoneID();
        String phoneToken = app.getPhoneToken();

        assertEquals(testAndroidId, phoneId);

        assertNotNull(phoneToken);
        assertFalse(phoneToken.isEmpty());
        // Verify token is a valid UUID
        UUID uuid = UUID.fromString(phoneToken);
        assertNotNull(uuid);
    }

    @Test
    public void doesNotOverwriteExistingPhoneIdAndTokenOnLaunch() {
        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(app);
        prefs.edit()
                .putString("phone_id", "existing-id-123")
                .putString("phone_token", "existing-token-456")
                .commit();

        app.onCreate();

        assertEquals("existing-id-123", app.getPhoneID());
        assertEquals("existing-token-456", app.getPhoneToken());
    }

    @Test
    public void settersUpdatePhoneIdAndToken() {
        app.setPhoneID("custom-phone-id");
        app.setPhoneToken("custom-phone-token");

        assertEquals("custom-phone-id", app.getPhoneID());
        assertEquals("custom-phone-token", app.getPhoneToken());
    }
}
