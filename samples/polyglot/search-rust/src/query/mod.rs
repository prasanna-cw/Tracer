use super::index::Index;

pub struct Query(String);

impl Query {
    pub fn parse(s: &str) -> Self {
        Query(s.to_string())
    }

    pub fn run(&self) -> Vec<String> {
        Index.lookup(&self.0)
    }
}
