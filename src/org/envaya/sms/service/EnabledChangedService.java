package org.envaya.sms.service;

import android.app.AlarmManager;
import androidx.core.app.JobIntentService;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;
import org.envaya.sms.App;
import org.envaya.sms.receiver.NudgeReceiver;

public class EnabledChangedService extends JobIntentService {
    
    private static final int WORK_ID = 1;

    public static void enqueueWork(Context context, Intent work)
    {
        JobIntentService.enqueueWork(context, EnabledChangedService.class, WORK_ID, work);
    }

    private App app;
    
    public EnabledChangedService(String name)
    {
        super();        
    }
    
    public EnabledChangedService()
    {
        this("EnabledChangedService");
    }

    @Override
    public void onCreate() {
        super.onCreate();

        app = (App)this.getApplicationContext();
        
    }      
    
    @Override
    protected void onHandleWork(Intent intent)
    {  
        TelephonyManager telephony = (TelephonyManager)   
            getSystemService(Context.TELEPHONY_SERVICE);                  

        startService(new Intent(app, ForegroundService.class));
        
        app.setOutgoingMessageAlarm();

        AlarmManager alarmManager = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        alarmManager.cancel(PendingIntent.getBroadcast(app, 0, new Intent(app, NudgeReceiver.class), PendingIntent.FLAG_IMMUTABLE));
        
        if (app.isEnabled())
        {
            app.getMessagingObserver().register(); 

            telephony.listen(app.getCallListener(), PhoneStateListener.LISTEN_CALL_STATE);          

            app.getDatabaseHelper().restorePendingMessages();
            
            app.getAmqpConsumer().startAsync();
        }
        else
        {
            app.getMessagingObserver().unregister();
            telephony.listen(app.getCallListener(), PhoneStateListener.LISTEN_NONE);

            app.getAmqpConsumer().stopAsync();
        }                   
    }
}
