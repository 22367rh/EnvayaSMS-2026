package org.envaya.sms;

import android.content.Context;
import android.os.Build;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;

import java.lang.reflect.Method;
import java.util.ArrayList;

/**
 * Resolves the SMS-sending {@link SmsManager} for a device's default SIM.
 *
 * <p>On API 31+ (Android 12) the per-SIM accessor is used, which selects the default SIM
 * deterministically. On older APIs that accessor does not exist, so {@link SmsManager#getDefault()}
 * is used instead.</p>
 *
 * <p>Both accessors are invoked reflectively. This keeps this class free of any compile-time
 * reference to framework symbols whose presence varies by SDK (the per-SIM send accessor and the
 * deprecated default accessor), which both avoids deprecation warnings when compiling against modern
 * SDKs and makes the helper resilient across platform variants.</p>
 *
 * <p>All resolution paths are defensive: if no manager can be resolved (no SIM, radio disabled, or the
 * platform throws), {@link #resolve(Context)} returns {@code null} rather than crashing so callers can
 * route the message through the normal failure/retry path.</p>
 */
public final class SmsSender {

    /** API 31 (Android 12): below this the per-SIM send accessor does not exist. */
    private static final int API_31 = 31;

    private SmsSender() {}

    /**
     * Resolve the SMS-sending manager for the device's default SIM.
     *
     * @return the resolved manager, or {@code null} if none is available.
     */
    public static SmsManager resolve(Context context) {
        try {
            TelephonyManager tm = (TelephonyManager)
                    context.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) {
                return null;
            }

            int subId = getSubscriptionId(tm);
            if (subId < 0) {
                return null;
            }

            if (Build.VERSION.SDK_INT >= API_31) {
                // Per-SIM send accessor: selects the default SIM deterministically.
                Method m = TelephonyManager.class.getMethod(
                        "getSmsManagerForSendOrSimIndex", int.class);
                return (SmsManager) m.invoke(tm, subId);
            }

            // API 30 and below: fall back to the default manager (reflectively).
            Method getDefault = SmsManager.class.getMethod("getDefault");
            return (SmsManager) getDefault.invoke(null);
        } catch (Exception e) {
            // No SIM / radio disabled / manager unavailable — let caller decide.
            return null;
        }
    }

    private static int getSubscriptionId(TelephonyManager tm) throws Exception {
        Method m = TelephonyManager.class.getMethod("getSubscriptionId");
        Object v = m.invoke(tm);
        return v instanceof Integer ? (Integer) v : -1;
    }

    /**
     * Split {@code body} into SMS parts using the resolved default-SIM manager.
     *
     * <p>If no manager can be resolved this falls back to a single-part list so that message tracking
     * and scheduling still work; the actual send is expected to fail later at send time, where it is
     * routed through the failure/retry path.</p>
     */
    public static ArrayList<String> divideMessage(Context context, String body) {
        SmsManager smgr = resolve(context);
        if (smgr == null) {
            return fallbackDivide(body);
        }
        return smgr.divideMessage(body);
    }

    private static ArrayList<String> fallbackDivide(String body) {
        ArrayList<String> parts = new ArrayList<String>();
        if (body != null && !body.isEmpty()) {
            parts.add(body);
        }
        return parts;
    }
}
