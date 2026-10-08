
package org.envaya.sms;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import java.util.*;

/*
 * Utilities for parsing MMS and SMS messages from the content provider tables 
 * of the Messaging app, as defined by android.provider.Telephony
 * 
 * MMS parsing is analogous to com.google.android.mms.pdu.PduPersister from 
 * core/java/com/google/android/mms/pdu in the base Android framework
 * (https://github.com/android/platform_frameworks_base)
 */
public class MessagingUtils
{
    // constants from android.provider.Telephony
    public static final Uri MMS_INBOX_URI = Uri.parse("content://mms/inbox");        
    public static final Uri MMS_PART_URI = Uri.parse("content://mms/part");    
    
    public static final Uri SENT_SMS_URI = Uri.parse("content://sms/sent");

    // content://sms/inbox holds messages received by the device. Since Android 4.4 (API 19) only
    // the default SMS app reliably receives the SMS_RECEIVED broadcast and can abortBroadcast(),
    // we also poll this provider (like MMS) so inbound forwarding keeps working on modern devices
    // even when EnvayaSMS is not the default texting app. See upgrade-plan/11-inbound-sms-behavior-changes.md.
    public static final Uri INBOX_SMS_URI = Uri.parse("content://sms/inbox");    
    
    // constants from com.google.android.mms.pdu.PduHeaders  
    private static final int PDU_HEADER_FROM = 0x89;    
    private static final int MESSAGE_TYPE_RETRIEVE_CONF = 0x84;
    
    // todo -- prevent (very slow) unbounded growth?
    private final Set<Long> seenMmsIds = new HashSet<Long>();
    
    private final Set<Long> seenSentSmsIds = new HashSet<Long>();

    // _ids of inbox SMS rows already forwarded, so we don't re-forward them. Mirrors seenSentSmsIds.
    private final Set<Long> seenIncomingSmsIds = new HashSet<Long>();
    
    private App app;
    private ContentResolver contentResolver;
    
    public MessagingUtils(App app)
    {
        this.app = app;
        this.contentResolver = app.getContentResolver();
    }
    
    public List<MmsPart> getMmsParts(long id)
    {        
        Cursor cur = contentResolver.query(MMS_PART_URI, new String[] {
            "_id", "ct", "name", "text", "cid", "_data"
        }, "mid = ?", new String[] { "" + id }, null);

        // assume that if there is at least one part saved in database
        // then MMS is fully delivered (this seems to be true in practice)

        List<MmsPart> parts = new ArrayList<MmsPart>();
        
        while (cur.moveToNext())
        {
            long partId = cur.getLong(0);

            String contentType = cur.getString(1);
            
            if (contentType == null)
            {
                continue;
            }
            
            MmsPart part = new MmsPart(app, partId);            
            
            part.setContentType(contentType);
            
            String name = cur.getString(2);
            
            if (name == null || name.length() == 0)
            {
                // POST request for incoming MMS will fail if the filename is empty
                name = UUID.randomUUID().toString().substring(0, 8); 
            }
            
            part.setName(name);

            part.setDataFile(cur.getString(5));
                
            // todo interpret charset like com.google.android.mms.pdu.EncodedStringValue
            part.setText(cur.getString(3));
            
            part.setContentId(cur.getString(4));
            
            parts.add(part);
        }

        cur.close();
               
        return parts;
    }
    
    /*
     * see com.google.android.mms.pdu.PduPersister.loadAddress
     */
    public String getMmsSenderNumber(long mmsId) {
        
        Uri uri = Uri.parse("content://mms/"+mmsId+"/addr");

        Cursor cur = contentResolver.query(uri, 
                new String[] { "address", "charset", "type" }, 
                null, null, null);

        String address = null;
        while (cur.moveToNext())
        {
            int addrType = cur.getInt(2);
            if (addrType == PDU_HEADER_FROM)
            {
                // todo interpret charset like com.google.android.mms.pdu.EncodedStringValue
                address = cur.getString(0);
            }
        }
        cur.close();

        return address;
    }
    
    public List<IncomingMms> getMessagesInMmsInbox()
    {
        return getMessagesInMmsInbox(false);
    }

    public synchronized List<IncomingMms> getMessagesInMmsInbox(boolean newMessagesOnly)
    {
        // the M-Retrieve.conf messages are the 'actual' MMS messages        
        String m_type = "" + MESSAGE_TYPE_RETRIEVE_CONF;

        Cursor c = contentResolver.query(MMS_INBOX_URI, 
                new String[] {"_id", "ct_l", "date"}, 
                "m_type = ? ", new String[] { m_type }, 
                "_id desc limit 30");
        
        List<IncomingMms> messages = new ArrayList<IncomingMms>();        
        
        while (c.moveToNext())
        {         
            long id = c.getLong(0);         
            
            if (newMessagesOnly && seenMmsIds.contains(id))
            {
                // avoid fetching all the info for old MMS messages if we're only interested in new ones
                continue;
            }
            
            long date = c.getLong(2);            
            
            IncomingMms mms = new IncomingMms(app, 
                date * 1000, // MMS timestamp is in seconds for some reason, 
                             // while everything else is in ms
                id);
                        
            messages.add(mms);
        }
        c.close();
        
        return messages;
    }
    
    public synchronized boolean deleteFromMmsInbox(IncomingMms mms)
    {        
        long id = mms.getMessagingId();
                
        Uri uri = Uri.parse("content://mms/inbox/" + id);            
        int res = contentResolver.delete(uri, null, null);
                
        if (res > 0)
        {
            app.log("MMS id="+id+" deleted from inbox");
            
            // remove id from set because Messaging app reuses ids 
            // of deleted messages.             
            // TODO: handle reuse of IDs deleted directly through Messaging
            // app while EnvayaSMS is running
            seenMmsIds.remove(id);
        }
        else
        {
            app.log("MMS id="+id+" could not be deleted from inbox");
        }
        return res  > 0;
    }
    
    public synchronized void markSeenMms(IncomingMms mms)
    {
        long id = mms.getMessagingId();        
        seenMmsIds.add(id);
    }
    
    public synchronized List<IncomingSms> getSentSmsMessages()
    {
        return getSentSmsMessages(false);
    }
    
    public synchronized List<IncomingSms> getSentSmsMessages(boolean newMessagesOnly)
    {
        Cursor c = contentResolver.query(SENT_SMS_URI,
                new String[]{"_id", "address", "body", "date"}, null, null,
                "_id desc limit 30");
        
        // SMS messages sent via Messaging app are considered as IncomingSms (with direction=Direction.Sent) 
        // because they're incoming to the server (whereas OutgoingSms would indicate a message we will try to send)
        List<IncomingSms> messages = new ArrayList<IncomingSms>();        
        
        while (c.moveToNext())
        {         
            long id = c.getLong(0);         
            
            if (newMessagesOnly && seenSentSmsIds.contains(id))
            {
                continue;
            }
            
            IncomingSms sms = new IncomingSms(app);
            sms.setMessagingId(id);
            sms.setTo(c.getString(1));
            sms.setMessageBody(c.getString(2));
            sms.setTimestamp(c.getLong(3));
            sms.setDirection(IncomingSms.Direction.Sent);
            
            messages.add(sms);
        }
        c.close();
        
        return messages;
    }
    
    public synchronized void markSeenSentSms(IncomingSms sms)
    {
        long id = sms.getMessagingId();
        if (id > 0)
        {
            seenSentSmsIds.add(id);
        }
    }

    /*
     * Read SMS rows that arrived in the device inbox since EnvayaSMS last looked. This is the
     * content-provider equivalent of the SMS_RECEIVED broadcast that SmsReceiver used to rely on;
     * it lets inbound forwarding work without being the default SMS app. Rows are read newest-first,
     * mirroring getSentSmsMessages(). The "date" column here is already in milliseconds.
     */
    public synchronized List<IncomingSms> getNewIncomingSmsFromInbox()
    {
        return getNewIncomingSmsFromInbox(false);
    }

    public synchronized List<IncomingSms> getNewIncomingSmsFromInbox(boolean newMessagesOnly)
    {
        Cursor c = contentResolver.query(INBOX_SMS_URI,
                new String[]{"_id", "address", "body", "date"}, null, null,
                "_id desc limit 30");

        List<IncomingSms> messages = new ArrayList<IncomingSms>();

        while (c.moveToNext())
        {
            long id = c.getLong(0);

            if (newMessagesOnly && seenIncomingSmsIds.contains(id))
            {
                continue;
            }

            String from = c.getString(1);
            String body = c.getString(2);
            long date = c.getLong(3);

            IncomingSms sms = new IncomingSms(app);
            sms.setMessagingId(id);
            if (from != null)
            {
                sms.setFrom(from);
            }
            sms.setMessageBody(body);
            sms.setTimestamp(date);
            // Received messages are direction=Incoming; isForwardable() then keys off the sender.
            sms.setDirection(IncomingSms.Direction.Incoming);

            messages.add(sms);
        }
        c.close();

        return messages;
    }

    public synchronized void markSeenIncomingSms(IncomingSms sms)
    {
        long id = sms.getMessagingId();
        if (id > 0)
        {
            seenIncomingSmsIds.add(id);
        }
    }    
}
