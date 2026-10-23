pub struct Index;

impl Index {
    pub fn lookup(&self, term: &str) -> Vec<String> {
        vec![term.to_string()]
    }
}
