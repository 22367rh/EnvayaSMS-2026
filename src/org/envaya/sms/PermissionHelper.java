package org.envaya.sms;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;

/**
 * Central place for the modern (runtime) permission model.
 *
 * <p>The app targets API 34, so dangerous permissions &mdash; including the SMS group
 * (classified as "development-verified" on Android 13+) and {@link #POST_NOTIFICATIONS}
 * on API 33+ &mdash; must be granted at runtime before the corresponding feature runs.
 * A missing permission degrades the affected feature gracefully rather than crashing.</p>
 */
public final class PermissionHelper {

    private PermissionHelper() {}

    /** Development-verified dangerous permissions required for SMS send/receive. */
    public static final String[] SMS_PERMISSIONS = {
        "android.permission.RECEIVE_SMS",
        "android.permission.SEND_SMS",
        "android.permission.READ_SMS",
        "android.permission.WRITE_SMS",
        "android.permission.RECEIVE_MMS",
    };

    /** API 33+ permission required before notifications are shown to the user. */
    public static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

    /** True when {@link #POST_NOTIFICATIONS} is still missing on API 33+. */
    public static boolean needsPostNotifications(Context context) {
        return Build.VERSION.SDK_INT >= 33 && !hasPermission(context, POST_NOTIFICATIONS);
    }

    public static boolean hasPermission(Context context, String permission) {
        // ContextCompat tolerates pre-API-23 runtimes (the framework checkSelfPermission does not).
        return ContextCompat.checkSelfPermission(context, permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean hasAllPermissions(Context context, String... permissions) {
        for (String p : permissions) {
            if (!hasPermission(context, p)) {
                return false;
            }
        }
        return true;
    }
}
