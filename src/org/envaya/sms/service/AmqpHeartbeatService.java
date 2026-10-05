package org.envaya.sms.service;

import androidx.core.app.JobIntentService;
import android.content.Context;
import android.content.Intent;
import org.envaya.sms.AmqpConsumer;
import org.envaya.sms.App;

public class AmqpHeartbeatService extends JobIntentService {
    
    private static final int WORK_ID = 4;

    public static void enqueueWork(Context context, Intent work)
    {
        JobIntentService.enqueueWork(context, AmqpHeartbeatService.class, WORK_ID, work);
    }

    private App app;
    
    public AmqpHeartbeatService(String name)
    {
        super();        
    }
    
    public AmqpHeartbeatService()
    {
        this("AmqpHeartbeatService");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        app = (App)this.getApplicationContext();        
    }      
    
    @Override
    protected void onHandleWork(Intent intent)
    {          
        AmqpConsumer consumer = app.getAmqpConsumer();
        consumer.sendHeartbeatBlocking();
    }
}
