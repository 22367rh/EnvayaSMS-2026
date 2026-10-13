package org.envaya.sms.task;

import org.envaya.sms.IncomingMessage;
import okhttp3.Response;

public class ForwarderTask extends HttpTask {

    private IncomingMessage message;

    public ForwarderTask(IncomingMessage message, NameValuePair... paramsArr) {
        super(message.app, paramsArr);
        this.message = message;                
    }
    
    @Override
    protected String getDefaultToAddress() {
        return message.getFrom();
    }

    @Override
    protected void handleResponse(Response response) throws Exception {
        app.inbox.messageForwarded(message);       
        super.handleResponse(response);
    }

    @Override
    protected void handleFailure() {        
        app.inbox.messageFailed(message);
    } 
}
