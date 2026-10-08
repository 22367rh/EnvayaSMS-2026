package org.envaya.sms.receiver;

import org.envaya.sms.App;
import org.envaya.sms.OutgoingMessage;
import org.envaya.sms.SmsSender;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.telephony.SmsManager;
import java.util.ArrayList;

public class OutgoingSmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) 
    {
        Bundle extras = intent.getExtras();
        String to = extras.getString(App.OUTGOING_SMS_EXTRA_TO);
        ArrayList<String> bodyParts = extras.getStringArrayList(App.OUTGOING_SMS_EXTRA_BODY);
        boolean deliveryReport = extras.getBoolean(App.OUTGOING_SMS_EXTRA_DELIVERY_REPORT, false);
        
        // Resolve the default-SIM send manager (SIM-aware on API 31+, reflective fallback below).
        SmsManager smgr = SmsSender.resolve(context);

        ArrayList<PendingIntent> sentIntents = new ArrayList<PendingIntent>();
        ArrayList<PendingIntent> deliveryIntents = null;
        
        if (deliveryReport)
        {
            deliveryIntents = new ArrayList<PendingIntent>();
        }
        
        int numParts = bodyParts.size();
        
        for (int i = 0; i < numParts; i++)
        {
           Intent statusIntent = new Intent(App.MESSAGE_STATUS_INTENT, intent.getData());
           statusIntent.putExtra(App.STATUS_EXTRA_INDEX, i);
           statusIntent.putExtra(App.STATUS_EXTRA_NUM_PARTS, numParts);
            
           sentIntents.add(PendingIntent.getBroadcast(
                context,
                0,
                statusIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT));

            if (deliveryReport)
            {
                Intent deliveryIntent = new Intent(App.MESSAGE_DELIVERY_INTENT, intent.getData());
                deliveryIntent.putExtra(App.STATUS_EXTRA_INDEX, i);
                deliveryIntent.putExtra(App.STATUS_EXTRA_NUM_PARTS, numParts);            

                deliveryIntents.add(PendingIntent.getBroadcast(
                    context,
                    0,
                    deliveryIntent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT));                   
            }
        }        

        if (smgr == null)
        {
            // No SMS manager available (no SIM / radio disabled). Route through the failure/retry
            // path so the message is not silently dropped.
            App app = (App) context.getApplicationContext();
            OutgoingMessage msg = app.outbox.getMessage(intent.getData());
            if (msg != null)
            {
                app.outbox.messageFailed(msg, "SMS manager unavailable");
            }
            return;
        }

        try
        {
            smgr.sendMultipartTextMessage(to, null, bodyParts, sentIntents, deliveryIntents);
        }
        catch (Exception e)
        {
            // sendMultipartTextMessage can throw synchronously (e.g. radio off / invalid args).
            // Route through the failure/retry path instead of dropping the message.
            App app = (App) context.getApplicationContext();
            OutgoingMessage msg = app.outbox.getMessage(intent.getData());
            if (msg != null)
            {
                app.outbox.messageFailed(msg, "SMS send failed: " + e.getMessage());
            }
        }
    }
}