package org.envaya.sms.task;

import android.os.AsyncTask;
import android.os.Build;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import okhttp3.FormBody;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.envaya.sms.App;
import org.envaya.sms.JsonUtils;
import org.envaya.sms.R;
import org.envaya.sms.XmlUtils;

/**
 * Base class for background server requests. The transport has been migrated off
 * the old Apache HTTP stack (gone from the platform in API 23) to OkHttp:
 * request building produces an okhttp3.Request and the async result is an
 * okhttp3.Response. Response-processing callbacks, content-type dispatch and the
 * X-Request-Signature header are preserved unchanged in logic.
 */
public class BaseHttpTask extends AsyncTask<String, Void, Response> {
    
    protected App app;
    protected String url;    
    protected List<NameValuePair> params = new ArrayList<NameValuePair>();    

    private List<MultipartPart> formParts;
    protected boolean useMultipartPost = false;    
    protected Request post;
    protected Throwable requestException;
    
    public BaseHttpTask(App app, String url, NameValuePair... paramsArr)
    {
        this.url = url;
        this.app = app;                
        params = new ArrayList<NameValuePair>(Arrays.asList(paramsArr));
        
        params.add(new NameValuePair("version", "" + app.getPackageInfo().versionCode));
    }
    
    public void addParam(String name, String value)
    {
        params.add(new NameValuePair(name, value));
    }    
    
    public void setFormParts(List<MultipartPart> formParts)
    {
        useMultipartPost = true;
        this.formParts = formParts;
    }                     

    protected Request makeHttpPost() throws Exception
    {
        Request.Builder requestBuilder = new Request.Builder().url(url);

        requestBuilder.header("User-Agent", app.getText(R.string.app_name) + "/" + app.getPackageInfo().versionName + " (Android; SDK " + Build.VERSION.SDK_INT + "; " + Build.MANUFACTURER + "; " + Build.MODEL + ")");

        RequestBody body;
        if (useMultipartPost)
        {
            // Order preserved: text params first, then binary parts -- matches the
            // previous multipart-entity field ordering. MultipartBody.Builder is the
            // 3.x multipart builder (the old MultipartBuilder wrapper is absent from
            // this OkHttp variant).
            MultipartBody.Builder multipart = new MultipartBody.Builder().setType(MultipartBody.FORM);
            for (NameValuePair param : params)
            {
                multipart.addFormDataPart(param.getName(), param.getValue());
            }
            for (MultipartPart formPart : formParts)
            {
                // getMediaType() is already an okhttp3.MediaType (or null); pass it
                // straight into the binary part's RequestBody.
                multipart.addFormDataPart(formPart.getName(), formPart.getFilename(),
                        RequestBody.create(formPart.getMediaType(), formPart.getData()));
            }
            body = multipart.build();
        }
        else
        {
            FormBody.Builder form = new FormBody.Builder();
            for (NameValuePair param : params)
            {
                form.add(param.getName(), param.getValue());
            }
            body = form.build();
        }

        requestBuilder.post(body);
        return requestBuilder.build();
    }
    
    protected Response doInBackground(String... ignored) 
    {    
        try
        {
            post = makeHttpPost();
            
            OkHttpClient client = app.getHttpClient();
            return client.newCall(post).execute();            
        }     
        catch (Throwable ex) 
        {
            requestException = ex;
            
            try
            {
                String message = ex.getMessage();
                // workaround for https://issues.apache.org/jira/browse/HTTPCLIENT-881
                if ((ex instanceof IOException) 
                        && message != null && message.equals("Connection already shutdown"))
                {
                    // app.log("Retrying request");
                    post = makeHttpPost();
                    OkHttpClient client = app.getHttpClient();
                    
                    return client.newCall(post).execute();  
                }
            }
            catch (Throwable ex2)
            {
                requestException = ex2;
            }            
        }   
        
        return null;
    }    
           
    protected String getErrorText(Response response)    
            throws Exception
    {
        String contentType = getContentType(response);
        String error = null;
        
        if (contentType.startsWith("application/json"))
        {
            JSONObject json = JsonUtils.parseResponse(response);
            error = JsonUtils.getErrorText(json);
        }
        else if (contentType.startsWith("text/xml"))
        {
            Document xml = XmlUtils.parseResponse(response);
            error = XmlUtils.getErrorText(xml);
        }
        
        if (error == null)
        {
            error = "HTTP " + response.code();
        }
        return error;
    }
    
    protected String getContentType(Response response)
    {
        String contentTypeHeader = response.header("Content-Type");
        return (contentTypeHeader != null) ? contentTypeHeader : "";
    }
    
    @Override
    protected void onPostExecute(Response response) {
        if (response != null)
        {                
            try
            {
                int statusCode = response.code();
                
                if (statusCode == 200) 
                {
                    handleResponse(response);
                } 
                else if (statusCode >= 400 && statusCode <= 499)
                {
                    handleErrorResponse(response);
                    handleFailure();
                }
                else
                {
                    throw new Exception("HTTP " + statusCode);
                }
            }
            catch (Throwable ex)
            {
                // OkHttp Request objects carry no abortable connection state;
                // releasing is handled below via response.body().close().
                handleResponseException(ex);
                handleFailure();
            }
            
            // OkHttp: releasing the body replaces the old Apache
            // entity.consumeContent(). close() here does not throw a checked
            // exception in this OkHttp variant, so no try/catch is required.
            if (response.body() != null) {
                response.body().close();
            }
        }
        else
        {
            handleRequestException(requestException);
            handleFailure();
        }
    }
    
    protected void handleResponse(Response response) throws Exception
    {
    }
    
    protected void handleErrorResponse(Response response) throws Exception
    {
    }        
    
    protected void handleFailure()
    {
    }            

    protected void handleRequestException(Throwable ex)
    {       
    }

    protected void handleResponseException(Throwable ex)
    {       
    }    
        
}
