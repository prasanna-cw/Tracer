package com.acme.orders.model;

public record Order(String sku, int qty) {
    public String id() {
        return sku + ":" + qty;
    }
}
