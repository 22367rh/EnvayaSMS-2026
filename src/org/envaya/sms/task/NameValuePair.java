package org.envaya.sms.task;

/**
 * Minimal name/value pair, a drop-in replacement for the older Apache HTTP
 * name/value-pair type that was removed from the Android platform in API 23.
 * Kept
 * tiny: only getName()/getValue() are used by the request-building and
 * request-building and signature code.
 */
public class NameValuePair {

    private final String name;
    private final String value;

    public NameValuePair(String name, String value) {
        this.name = name;
        this.value = value;
    }

    public String getName() {
        return name;
    }

    public String getValue() {
        return value;
    }
}
