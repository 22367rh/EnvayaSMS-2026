package org.envaya.sms.ui;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import org.envaya.sms.App;
import org.envaya.sms.R;
import java.text.DateFormat;
import java.util.Date;

public class StatusView extends Activity {

    private App app;
    private TextView serverUrlView;
    private TextView connectionStateView;
    private TextView lastSuccessView;
    private TextView lastOutgoingView;
    private TextView lastIncomingView;
    private TextView lastDeviceStatusView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        app = (App) getApplication();
        setContentView(R.layout.status_view);

        serverUrlView = (TextView) findViewById(R.id.status_server_url);
        connectionStateView = (TextView) findViewById(R.id.status_connection_state);
        lastSuccessView = (TextView) findViewById(R.id.status_last_success);
        lastOutgoingView = (TextView) findViewById(R.id.status_last_outgoing);
        lastIncomingView = (TextView) findViewById(R.id.status_last_incoming);
        lastDeviceStatusView = (TextView) findViewById(R.id.status_last_device_status);

        Button refreshButton = (Button) findViewById(R.id.status_refresh_button);
        refreshButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                updateStatus();
            }
        });

        updateStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private void updateStatus() {
        String url = app.getServerUrl();
        serverUrlView.setText(url.length() > 0 ? url : "(Server URL not set)");

        String status = app.getServerStatus();
        if (status.equals("active")) {
            connectionStateView.setText("ACTIVE (Green - connected within last 10 mins)");
            connectionStateView.setTextColor(Color.parseColor("#2E7D32")); // Dark green
        } else if (status.equals("degraded")) {
            connectionStateView.setText("DEGRADED (Orange - latest communication failed)");
            connectionStateView.setTextColor(Color.parseColor("#EF6C00")); // Orange
        } else if (status.equals("broken")) {
            connectionStateView.setText("BROKEN (Red - 3+ connection issues in last 10 mins)");
            connectionStateView.setTextColor(Color.parseColor("#C62828")); // Red
        } else {
            connectionStateView.setText("UNKNOWN / INACTIVE");
            connectionStateView.setTextColor(Color.GRAY);
        }

        lastSuccessView.setText(formatTime(app.getLastSuccessfulServerConnectionTime()));
        lastOutgoingView.setText(formatTime(app.getLastOutgoingMessageTime()));
        lastIncomingView.setText(formatTime(app.getLastIncomingMessageUpdateTime()));
        lastDeviceStatusView.setText(formatTime(app.getLastDeviceStatusTime()));
    }

    private String formatTime(long timestamp) {
        if (timestamp <= 0) {
            return "Never";
        }
        Date date = new Date(timestamp);
        return DateFormat.getDateTimeInstance().format(date);
    }
}
