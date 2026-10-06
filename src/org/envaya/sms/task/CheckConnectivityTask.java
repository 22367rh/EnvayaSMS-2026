package org.envaya.sms.task;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.envaya.sms.App;
import org.envaya.sms.receiver.ReenableWifiReceiver;
import java.io.IOException;
import java.net.InetAddress;
import java.util.concurrent.Executor;


public class CheckConnectivityTask {

    // Delivers results back onto the UI/main thread, as AsyncTask did previously.
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());

    protected App app;
    protected String hostName;
    protected int networkType;

    // Replaces AsyncTask.getStatus(): guards against starting a duplicate check
    // while one is already in flight (mirrors the old getStatus() != FINISHED).
    private volatile boolean running = false;

    public CheckConnectivityTask(App app, String hostName, int networkType)
    {
        this.app = app;
        this.hostName = hostName;
        this.networkType = networkType;
    }

    public boolean isRunning()
    {
        return running;
    }

    /**
     * Runs doInBackground() on the given background executor, then posts the result
     * to onResponse() on the main thread. A second execute() while one is already
     * running is a no-op, matching the old "don't start if not FINISHED" guard.
     */
    public void execute(final Executor executor)
    {
        if (running)
        {
            return;
        }
        running = true;
        final CheckConnectivityTask self = this;
        executor.execute(new Runnable()
        {
            @Override
            public void run()
            {
                Boolean reachable;
                try
                {
                    reachable = doInBackground((String[]) null);
                }
                catch (Throwable t)
                {
                    reachable = null;
                }
                final Boolean result = reachable;
                MAIN_HANDLER.post(new Runnable()
                {
                    @Override
                    public void run()
                    {
                        try
                        {
                            onResponse(result);
                        }
                        finally
                        {
                            running = false;
                        }
                    }
                });
            }
        });
    }

    protected Boolean doInBackground(String... ignored)
    {
        try
        {
            Thread.sleep(1000);

            InetAddress addr = InetAddress.getByName(hostName);
            if (addr.isReachable(App.HTTP_CONNECTION_TIMEOUT))
            {
                return true;
            }
        }
        catch (InterruptedException ex)
        {

        }
        catch (IOException ex)
        {
            // just what we suspected...
            // server not reachable on this interface
        }

        return false;
    }



    protected void onResponse(Boolean reachable)
    {
        if (reachable.booleanValue())
        {
            app.log("OK");
            app.onConnectivityRestored();
        }
        else
        {
            app.log("Can't connect to "+hostName+".");

            WifiManager wmgr = (WifiManager)app.getSystemService(Context.WIFI_SERVICE);

            if (!app.isNetworkFailoverEnabled())
            {
                app.debug("Network failover disabled.");
            }
            else if (networkType == ConnectivityManager.TYPE_WIFI)
            {
                app.log("Switching from WIFI to MOBILE");

                PendingIntent pendingIntent = PendingIntent.getBroadcast(app,
                    0,
                    new Intent(app, ReenableWifiReceiver.class),
                    PendingIntent.FLAG_IMMUTABLE);

                // set an alarm to try restoring Wi-Fi in a little while
                AlarmManager alarm =
                    (AlarmManager)app.getSystemService(Context.ALARM_SERVICE);

                alarm.set(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + App.DISABLE_WIFI_INTERVAL,
                    pendingIntent);

                wmgr.setWifiEnabled(false);
            }
            else if (networkType == ConnectivityManager.TYPE_MOBILE
                    && !wmgr.isWifiEnabled())
            {
                app.log("Switching from MOBILE to WIFI");
                wmgr.setWifiEnabled(true);
            }
            else
            {
                app.log("Can't automatically fix connectivity.");
            }
        }
    }

}
