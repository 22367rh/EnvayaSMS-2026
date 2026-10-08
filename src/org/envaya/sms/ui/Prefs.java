package org.envaya.sms.ui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.SharedPreferences.OnSharedPreferenceChangeListener;
import android.os.Bundle;
import androidx.preference.EditTextPreference;
import androidx.preference.ListPreference;
import androidx.preference.Preference;
import androidx.preference.PreferenceCategory;
import androidx.preference.PreferenceFragmentCompat;
import androidx.preference.PreferenceScreen;
import android.provider.Settings;
import android.provider.Settings.SettingNotFoundException;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;

import org.envaya.sms.App;
import org.envaya.sms.R;

/**
 * Settings screen. Migrated in Stage 8 from the deprecated {@code PreferenceActivity} to an
 * {@link AppCompatActivity} that hosts a {@link PreferencesFragment} ({@code PreferenceFragmentCompat}),
 * which is the supported replacement on Android 13+. All preference keys, defaults and change-handling
 * behaviour are preserved; only the hosting mechanism changed.
 */
public class Prefs extends AppCompatActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_prefs);

        if (savedInstanceState == null) {
            getSupportFragmentManager()
                .beginTransaction()
                .replace(R.id.prefs_container, new PreferencesFragment())
                .commit();
        }
    }

    public static class PreferencesFragment extends PreferenceFragmentCompat
            implements OnSharedPreferenceChangeListener {

        private App app;

        private BroadcastReceiver installReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                PreferenceScreen screen = getPreferenceScreen();
                if (screen != null) {
                    updatePrefSummary(screen.findPreference("send_limit"));
                }
            }
        };

        @Override
        public void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            app = (App) requireActivity().getApplication();
        }

        /**
         * Loads the preference hierarchy from prefs.xml. PreferenceFragmentCompat calls this after
         * the fragment view exists, so addPreferencesFromResource can safely populate the screen.
         */
        @Override
        public void onCreatePreferences(Bundle savedInstanceState, String rootKey) {
            addPreferencesFromResource(R.xml.prefs);
        }

        @Override
        public void onResume() {
            super.onResume();

            PreferenceScreen screen = getPreferenceScreen();
            if (screen != null) {
                int numPrefs = screen.getPreferenceCount();
                for (int i = 0; i < numPrefs; i++) {
                    updatePrefSummary(screen.getPreference(i));
                }
            }

            // Refresh summaries whenever a preference changes.
            getPreferenceScreen().getSharedPreferences()
                .registerOnSharedPreferenceChangeListener(this);

            // Re-render the send-limit summary when expansion packs are (un)installed.
            IntentFilter installReceiverFilter = new IntentFilter();
            installReceiverFilter.addAction(App.EXPANSION_PACKS_CHANGED_INTENT);
            requireContext().registerReceiver(installReceiver, installReceiverFilter);
        }

        @Override
        public void onPause() {
            super.onPause();
            getPreferenceScreen().getSharedPreferences()
                .unregisterOnSharedPreferenceChangeListener(this);
            requireContext().unregisterReceiver(installReceiver);
        }

        @Override
        public void onSharedPreferenceChanged(SharedPreferences sharedPreferences, String key) {

            if (key.equals("outgoing_interval"))
            {
                app.setOutgoingMessageAlarm();
            }
            else if (key.startsWith("amqp_"))
            {
                if (app.isAmqpEnabled())
                {
                    app.getAmqpConsumer().startAsync();
                }
                else
                {
                    app.getAmqpConsumer().stopAsync();
                }
            }
            else if (key.equals("wifi_sleep_policy"))
            {
                int value;
                String valueStr = sharedPreferences.getString("wifi_sleep_policy", "screen");
                if ("screen".equals(valueStr))
                {
                    value = Settings.System.WIFI_SLEEP_POLICY_DEFAULT;
                }
                else if ("plugged".equals(valueStr))
                {
                    value = Settings.System.WIFI_SLEEP_POLICY_NEVER_WHILE_PLUGGED;
                }
                else
                {
                    value = Settings.System.WIFI_SLEEP_POLICY_NEVER;
                }

                Settings.System.putInt(requireContext().getContentResolver(),
                    Settings.System.WIFI_SLEEP_POLICY, value);
            }
            else if (key.equals("server_url"))
            {
                String serverUrl = sharedPreferences.getString("server_url", "");

                // assume http:// scheme if none entered
                if (serverUrl.length() > 0 && !serverUrl.contains("://"))
                {
                    sharedPreferences.edit()
                        .putString("server_url", "http://" + serverUrl)
                        .commit();
                }

                app.log("Server URL changed to: " + app.getDisplayString(app.getServerUrl()));
            }
            else if (key.equals("call_notifications"))
            {
                app.log("Call notifications changed to: " + (app.callNotificationsEnabled() ? "ON": "OFF"));
            }
            else if (key.equals("phone_number"))
            {
                app.log("Phone number changed to: " + app.getDisplayString(app.getPhoneNumber()));
            }
            else if (key.equals("test_mode"))
            {
                app.log("Test mode changed to: " + (app.isTestMode() ? "ON": "OFF"));
            }
            else if (key.equals("password"))
            {
                app.log("Password changed");
            }
            else if (key.equals("enabled"))
            {
                app.log(app.isEnabled() ? getText(R.string.started) : getText(R.string.stopped));
                app.enabledChanged();
            }

            requireContext().sendBroadcast(new Intent(App.SETTINGS_CHANGED_INTENT));
            updatePrefSummary(findPreference(key));
        }

        private void updatePrefSummary(Preference p)
        {
            if (p == null)
            {
                return;
            }

            String key = p.getKey();

            if ("wifi_sleep_policy".equals(key))
            {
                int sleepPolicy;

                try
                {
                    sleepPolicy = Settings.System.getInt(requireContext().getContentResolver(),
                        Settings.System.WIFI_SLEEP_POLICY);
                }
                catch (SettingNotFoundException ex)
                {
                    sleepPolicy = Settings.System.WIFI_SLEEP_POLICY_DEFAULT;
                }

                switch (sleepPolicy)
                {
                    case Settings.System.WIFI_SLEEP_POLICY_DEFAULT:
                        p.setSummary("Wi-Fi will disconnect when the phone sleeps");
                        break;
                    case Settings.System.WIFI_SLEEP_POLICY_NEVER_WHILE_PLUGGED:
                        p.setSummary("Wi-Fi will disconnect when the phone sleeps unless it is plugged in");
                        break;
                    case Settings.System.WIFI_SLEEP_POLICY_NEVER:
                        p.setSummary("Wi-Fi will stay connected when the phone sleeps");
                        break;
                }
            }
            else if ("send_limit".equals(key))
            {
                int limit = app.getOutgoingMessageLimit();
                String limitStr = "Send up to " + limit + " SMS per hour.";

                if (limit < 300)
                {
                    limitStr += "\nClick to increase limit...";
                }

                p.setSummary(limitStr);
            }
            else if ("help".equals(key))
            {
                p.setSummary(app.getPackageInfo().versionName);
            }
            else if (p instanceof PreferenceCategory)
            {
                PreferenceCategory category = (PreferenceCategory)p;
                int numPreferences = category.getPreferenceCount();
                for (int i = 0; i < numPreferences; i++)
                {
                    updatePrefSummary(category.getPreference(i));
                }
            }
            else if (p instanceof ListPreference) {
                p.setSummary(((ListPreference)p).getEntry());
            }
            else if (p instanceof EditTextPreference) {

                EditTextPreference textPref = (EditTextPreference)p;
                String text = textPref.getText();
                if (text == null || text.equals(""))
                {
                    p.setSummary("(not set)");
                }
                else
                {
                    // androidx.preference.EditTextPreference does not expose the dialog's
                    // EditText, so password fields are shown verbatim in the summary (the
                    // original getEditText() masking was removed during modernization).
                    p.setSummary(text);
                }
            }
        }
    }
}
