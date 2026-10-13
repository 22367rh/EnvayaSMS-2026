package org.envaya.sms.task;

import org.envaya.sms.App;
import org.envaya.sms.task.NameValuePair;
import okhttp3.Response;

public class PollerTask extends HttpTask {

    public PollerTask(App app) {
        super(app, new NameValuePair("action", App.ACTION_OUTGOING));
    }

    @Override
    protected void onPostExecute(Response response) {
        super.onPostExecute(response);
        app.markPollComplete();
    }
    
    @Override
    protected void handleUnknownContentType(String contentType)
            throws Exception
    {
        throw new Exception("Invalid response type " + contentType);
    }
}
