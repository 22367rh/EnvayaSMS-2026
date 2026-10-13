package org.envaya.sms.ui;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import org.envaya.sms.App;
import org.envaya.sms.PermissionHelper;
import org.envaya.sms.ui.LogView;

public class Main extends Activity {

    private static final int REQUEST_POST_NOTIFICATIONS = 1;
    private static final int REQUEST_SMS_PERMISSIONS = 2;

    private App app;
    private boolean permissionsRequested = false;

    /** Called when the activity is first created. */
    @Override
    public void onCreate(Bundle savedInstanceState) {   
        super.onCreate(savedInstanceState);
        
        app = (App)getApplication();
                
        startActivity(new Intent(this, LogView.class));       
    }

    @Override
    public void onResume() {
        super.onResume();

        // Ask for runtime permissions once per process lifetime. Each is optional: the
        // affected feature degrades gracefully if denied (see PermissionHelper / ForegroundService).
        if (!permissionsRequested) {
            permissionsRequested = true;

            // API 33+: POST_NOTIFICATIONS must be granted before we can show notifications.
            if (PermissionHelper.needsPostNotifications(this)) {
                ActivityCompat.requestPermissions(this,
                        new String[]{PermissionHelper.POST_NOTIFICATIONS}, REQUEST_POST_NOTIFICATIONS);
            }

            // Development-verified dangerous permissions for SMS send/receive.
            if (!PermissionHelper.hasAllPermissions(this, PermissionHelper.SMS_PERMISSIONS)) {
                ActivityCompat.requestPermissions(this,
                        PermissionHelper.SMS_PERMISSIONS, REQUEST_SMS_PERMISSIONS);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Advisory only: denied permissions disable the matching feature without crashing.
    }
}
