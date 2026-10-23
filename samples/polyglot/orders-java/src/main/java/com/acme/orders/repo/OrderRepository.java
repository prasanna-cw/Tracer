package com.acme.orders.repo;

import com.acme.orders.model.Order;

public interface OrderRepository {
    void save(Order order);
    void rollback();
}
