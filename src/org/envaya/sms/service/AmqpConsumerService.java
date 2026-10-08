package org.envaya.sms.service;

import androidx.core.app.JobIntentService;
import android.content.Context;
import android.content.Intent;
import org.envaya.sms.AmqpConsumer;
import org.envaya.sms.App;

public class AmqpConsumerService extends JobIntentService {
    
    private static final int WORK_ID = 3;

    public static void enqueueWork(Context context, Intent work)
    {
        JobIntentService.enqueueWork(context, AmqpConsumerService.class, WORK_ID, work);
    }

    private App app;
    
    public AmqpConsumerService(String name)
    {
        super();        
    }
    
    public AmqpConsumerService()
    {
        this("AmqpConsumerService");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        app = (App)this.getApplicationContext();        
    }      
    
    @Override
    protected void onHandleWork(Intent intent)
    {  
        boolean start = intent.getBooleanExtra("start", false);
        
        AmqpConsumer consumer = app.getAmqpConsumer();
        if (start)
        {                       
            consumer.startBlocking();
        }
        else
        {
            consumer.stopBlocking();            
        }
        
    }
}
