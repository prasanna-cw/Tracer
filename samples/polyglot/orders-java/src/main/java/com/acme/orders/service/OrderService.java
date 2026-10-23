package com.acme.orders.service;

import com.acme.orders.model.Order;
import com.acme.orders.repo.OrderRepository;

public class OrderService {
    private final OrderRepository repo;

    public OrderService(OrderRepository repo) {
        this.repo = repo;
    }

    public String place(String sku, int qty) {
        Order order = new Order(sku, qty);
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                repo.save(order);
                return order.id();
            } catch (RuntimeException e) {
                repo.rollback();
            }
        }
        return null;
    }
}
