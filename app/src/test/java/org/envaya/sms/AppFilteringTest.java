package org.envaya.sms;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;
import android.preference.PreferenceManager;

import java.lang.reflect.Field;

import org.json.JSONArray;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for the regression-prone "should this message be forwarded / sent" domain logic that the
 * plan's Stage 13 calls out: {@link App#isForwardablePhoneNumber(String)} and
 * {@link OutgoingSms#validate()}.
 *
 * <p>Both getters used by {@code isForwardablePhoneNumber} ({@code getTestPhoneNumbers()},
 * {@code getIgnoredPhoneNumbers()}) cache their parsed list on first access, so this test resets those
 * private fields via reflection in {@link #setUp()} and rewrites the relevant prefs before each case to
 * keep tests isolated regardless of application-instance reuse.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AppFilteringTest {

    private App app;

    @Before
    public void setUp() throws Exception {
        app = (App) RuntimeEnvironment.getApplication();
        clearPrefs();
        resetListCaches();
    }

    // --- isForwardablePhoneNumber -----------------------------------------------------------------

    @Test
    public void numericLongNumberIsForwardableByDefault() {
        assertTrue(app.isForwardablePhoneNumber("15551234567"));
    }

    @Test
    public void shortcodeIsDroppedWhenIgnoringShortcodes() {
        putBool("ignore_shortcodes", true);

        assertFalse("a < 7-digit shortcode must be dropped when ignoring shortcodes",
                app.isForwardablePhoneNumber("12345"));
        // A normal-length number is unaffected by ignore_shortcodes.
        assertTrue(app.isForwardablePhoneNumber("15551234567"));
    }

    @Test
    public void nonNumericSenderIsDroppedWhenIgnoringNonNumeric() {
        putBool("ignore_non_numeric", true);

        assertFalse(app.isForwardablePhoneNumber("abcdefgh"));
    }

    @Test
    public void ignoredNumberIsNotForwardableButOthersAre() {
        putList("ignored_phone_numbers", "15550001111");

        assertFalse(app.isForwardablePhoneNumber("15550001111"));
        assertTrue(app.isForwardablePhoneNumber("15550002222"));
    }

    @Test
    public void testModeLimitsForwardingToList() {
        putBool("test_mode", true);
        putList("test_phone_numbers", "15559998888");

        assertTrue("a number on the test list must be forwardable in test mode",
                app.isForwardablePhoneNumber("15559998888"));
        assertFalse("an off-list number must not be forwardable in test mode",
                app.isForwardablePhoneNumber("15551110000"));
    }

    // --- OutgoingSms.validate() -------------------------------------------------------------------

    @Test(expected = ValidationException.class)
    public void validateRejectsEmptyTo() throws ValidationException {
        OutgoingSms sms = new OutgoingSms(app);
        sms.setTo("");
        sms.setMessageBody("hello");
        sms.validate();
    }

    @Test(expected = ValidationException.class)
    public void validateRejectsEmptyBody() throws ValidationException {
        OutgoingSms sms = new OutgoingSms(app);
        sms.setTo("15551234567");
        sms.setMessageBody("");
        sms.validate();
    }

    @Test
    public void validateAcceptsWellFormedMessage() throws ValidationException {
        OutgoingSms sms = new OutgoingSms(app);
        sms.setTo("15551234567");
        sms.setMessageBody("hello world");
        sms.validate(); // must not throw
    }

    // --- helpers ----------------------------------------------------------------------------------

    private void clearPrefs() {
        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(app);
        prefs.edit()
                .remove("test_mode")
                .remove("auto_add_test_number")
                .remove("ignore_shortcodes")
                .remove("ignore_non_numeric")
                .remove("ignored_phone_numbers")
                .remove("test_phone_numbers")
                .commit();
    }

    private void resetListCaches() {
        setField("testPhoneNumbers", null);
        setField("ignoredPhoneNumbers", null);
    }

    private void putBool(String key, boolean value) {
        PreferenceManager.getDefaultSharedPreferences(app).edit().putBoolean(key, value).commit();
    }

    private void putList(final String key, final String... values) {
        try {
            JSONArray arr = new JSONArray();
            for (String v : values) {
                arr.put(v);
            }
            PreferenceManager.getDefaultSharedPreferences(app)
                    .edit().putString(key, arr.toString()).commit();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private void setField(String name, Object value) {
        try {
            Field f = App.class.getDeclaredField(name);
            f.setAccessible(true);
            f.set(app, value);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
