mod index;
mod query;

use crate::query::Query;

fn main() {
    let q = Query::parse("rust");
    for hit in q.run() {
        println!("{}", hit);
    }
}
